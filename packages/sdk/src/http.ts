export class HttpCheckError extends Error {
  constructor(message: string, readonly code: 'redirect' | 'status' | 'too-large' | 'timeout' | 'network' | 'scheme' | 'destination') {
    super(message); this.name = 'HttpCheckError';
  }
}

export interface ReadLimitedOptions {
  /** Custom transports are trusted: they MUST enforce DNS/connection destination policy. */
  fetch?: typeof fetch;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
}

/** Bounds even injected transports/resolvers that do not honor cancellation. */
export async function withDeadline<T>(task: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new HttpCheckError('Deadline exceeded', 'timeout')); }, ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Conservative globally routable unicast allowlist; special-use ranges fail closed. */
export function isPublicAddress(ip: string): boolean {
  if (ip.includes(':')) {
    // Only global unicast, excluding mapped/transition/documentation/special ranges.
    const first = parseInt(ip.split(':')[0], 16);
    if (!(first >= 0x2000 && first <= 0x3fff)) return false;
    const lower = ip.toLowerCase();
    if (lower.includes('.') || lower.startsWith('2002:') || lower.startsWith('3fff:')) return false;
    if (first === 0x2001) {
      const second = parseInt(ip.split(':')[1] || '0', 16);
      if (second < 0x200 || second === 0xdb8) return false;
    }
    return true;
  }
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || +p > 255)) return false;
  const [a, b, c] = parts.map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}

export function checkDestination(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpCheckError('Invalid URL', 'scheme'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new HttpCheckError('Only HTTPS on port 443 without userinfo is supported', 'scheme');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.endsWith('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) {
    throw new HttpCheckError('Nonpublic hostname', 'destination');
  }
  if ((host.includes(':') || /^[\d.]+$/.test(host)) && !isPublicAddress(host)) throw new HttpCheckError('Nonpublic address', 'destination');
  return url;
}

/** Server default: validate ALL answers, then pin the checked address in the actual TLS connection. */
export async function publicFetch(value: string, init: RequestInit, overrides?: {
  lookup?: typeof import('node:dns/promises').lookup; request?: typeof import('node:https').request;
}): Promise<Response> {
  const url = checkDestination(value);
  const [{ lookup }, { request }, { isIP }, { Readable }] = await Promise.all([
    import('node:dns/promises'), import('node:https'), import('node:net'), import('node:stream'),
  ]);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await (overrides?.lookup ?? lookup)(host, { all: true, verbatim: true });
  if (!answers.length || answers.some(a => !isPublicAddress(a.address))) throw new HttpCheckError('DNS returned a nonpublic address', 'destination');
  if (init.signal?.aborted) throw new HttpCheckError('Deadline exceeded', 'timeout');
  const selected = answers[0];
  return new Promise<Response>((resolve, reject) => {
    const req = (overrides?.request ?? request)(url, {
      method: 'GET', family: selected.family, agent: false, signal: init.signal ?? undefined,
      // Prevent a second lookup/rebinding. TLS continues to verify the ORIGINAL hostname.
      lookup: (_hostname, _opts, callback) => callback(null, selected.address, selected.family),
      headers: { accept: 'application/json' },
    }, res => {
      const headers = new Headers();
      for (const [key, val] of Object.entries(res.headers)) if (val !== undefined) headers.set(key, Array.isArray(val) ? val.join(', ') : val);
      const status = res.statusCode ?? 500;
      if (status !== 200) { res.destroy(); resolve(new Response(null, { status, headers })); return; }
      resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
    });
    req.on('error', reject); req.end();
  });
}

/** One deadline covers DNS, redirects, headers, and body; every hop is checked. */
export async function readLimitedText(url: string, opts: ReadLimitedOptions): Promise<string> {
  const controller = new AbortController();
  const task = (async () => {
    let current = url;
    for (let hop = 0; ; hop++) {
      checkDestination(current);
      const res = await (opts.fetch ?? publicFetch)(current, {
        redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' },
      });
      if (controller.signal.aborted) { await res.body?.cancel(); throw new HttpCheckError('Deadline exceeded', 'timeout'); }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get('location');
        if (hop >= opts.maxRedirects || !location) throw new HttpCheckError('Redirect not allowed', 'redirect');
        current = new URL(location, current).toString(); continue;
      }
      if (res.status !== 200) { await res.body?.cancel(); throw new HttpCheckError(`HTTP ${res.status}`, 'status'); }
      if (Number(res.headers.get('content-length') ?? '0') > opts.maxBytes) {
        await res.body?.cancel(); throw new HttpCheckError('Body too large', 'too-large');
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = []; let total = 0;
      const abort = () => { void reader?.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        if (reader) for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          total += value.length;
          if (total > opts.maxBytes) throw new HttpCheckError('Body too large', 'too-large');
          chunks.push(value);
        }
        if (controller.signal.aborted) throw new HttpCheckError('Deadline exceeded', 'timeout');
        const bytes = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } finally {
        controller.signal.removeEventListener('abort', abort);
        if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
    }
  })();
  try { return await withDeadline(task, opts.timeoutMs, () => controller.abort()); }
  catch (e) { if (e instanceof HttpCheckError) throw e; throw new HttpCheckError('HTTPS request failed', 'network'); }
  finally { controller.abort(); }
}

// Dependency-free so browser code can use it through `@open-app-registry/sdk/register`.
import { MAX_URI_LEN } from './constants.js';

export type ManifestUriCheck = { ok: true } | { ok: false; detail: string };

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The ref segment of a raw source-forge URL, or undefined for any other host. */
function forgeRef(u: URL): string | undefined {
  const parts = u.pathname.split('/').filter(Boolean).map(p => { try { return decodeURIComponent(p); } catch { return p; } });
  if (u.hostname === 'raw.githubusercontent.com') return parts[2] ?? '';
  if (u.hostname === 'github.com' || u.hostname === 'www.github.com') {
    // github.com/<owner>/<repo>/raw|blob/<ref>/<path>; any other github.com page is not a raw file.
    return ['raw', 'blob'].includes(parts[2]) ? parts[3] ?? '' : '';
  }
  if (u.hostname === 'gitlab.com') {
    const i = parts.indexOf('-');
    return i >= 0 && ['raw', 'blob'].includes(parts[i + 1]) ? parts[i + 2] ?? '' : undefined;
  }
  if (u.hostname === 'cdn.jsdelivr.net' && parts[0] === 'gh') {
    const at = (parts[2] ?? '').indexOf('@');
    return at >= 0 ? parts[2].slice(at + 1) : '';
  }
  return undefined;
}

/**
 * Policy for a manifest URI about to be registered. The onchain hash already pins the content, so a URI that follows
 * a branch does not change what verifies; it breaks the record ("metadata unavailable") the next time the branch
 * moves. Source-forge URLs must therefore name a full commit SHA; ar:// and ipfs:// are content-addressed. The file
 * name `oar.json` is reserved for domain and repository proofs, so a proof can never double as a manifest.
 */
export function checkManifestUri(uri: string): ManifestUriCheck {
  if (new TextEncoder().encode(uri).length > MAX_URI_LEN) return { ok: false, detail: `manifest URI is longer than ${MAX_URI_LEN} bytes` };
  if (uri.startsWith('ar://') || uri.startsWith('ipfs://')) {
    return uri.length > (uri.startsWith('ar://') ? 5 : 7) ? { ok: true } : { ok: false, detail: 'manifest URI has no content identifier' };
  }
  if (!uri.startsWith('https://')) return { ok: false, detail: `unsupported manifest URI scheme (use https://, ar:// or ipfs://): ${uri}` };
  let u: URL;
  try { u = new URL(uri); } catch { return { ok: false, detail: `not a valid URL: ${uri}` }; }
  if (u.username || u.password) return { ok: false, detail: 'manifest URI must not embed credentials' };
  const file = u.pathname.split('/').filter(Boolean).pop() ?? '';
  if (file.toLowerCase() === 'oar.json') {
    return { ok: false, detail: '`oar.json` is reserved for domain and repository proofs; host the manifest as a separate file such as oar-manifest.json' };
  }
  const ref = forgeRef(u);
  if (ref !== undefined && !COMMIT_SHA.test(ref)) {
    return { ok: false, detail: `${uri} ${ref ? `follows the mutable reference "${ref}"` : 'does not name a commit'}; pin the manifest to a full commit SHA (or use ar:// or ipfs://)` };
  }
  return { ok: true };
}

import { fetchEncodedAccount, type Address, type GetAccountInfoApi, type Rpc } from '@solana/kit';
import {
  Compression,
  Encoding,
  Format,
  DataSource,
  decodeMetadata,
  findCanonicalPda,
} from '@solana-program/program-metadata';
import {
  DNS_LABEL,
  LIMITS,
  PROGRAM_METADATA_PROGRAM_ID,
  PROGRAM_METADATA_SEED,
  REPO_PROOF_FILE,
  WELL_KNOWN_PATH,
  type Cluster,
} from './constants.js';
import { withDeadline, HttpCheckError, readLimitedText } from './http.js';
import { DuplicateKeyError, parseJsonStrict } from './json.js';
import { validateProgramLink, validateProofFile, type ProgramLink, type ProofFile } from './manifest.js';

/** Result of one live link-proof check. */
export interface LinkCheck {
  state: 'verified' | 'unverified' | 'failed';
  method?: 'program-metadata' | 'well-known' | 'dns-txt' | 'repo-file';
  detail?: string;
}

// ---------------------------------------------------------------------------
// Programs: canonical Program Metadata account, seed "oar"
// ---------------------------------------------------------------------------

export type BacklinkResult =
  | { status: 'none'; metadataAddress: Address }
  | { status: 'invalid'; metadataAddress: Address; reason: string }
  | { status: 'ok'; metadataAddress: Address; link: ProgramLink; mutable: boolean };

/**
 * Read the program's canonical backlink. Only the upgrade authority (or its
 * delegate) can create the canonical account, and the content MUST use the
 * direct data source so it is stored onchain under that signature.
 */
export async function fetchProgramBacklink(
  rpc: Rpc<GetAccountInfoApi>,
  program: Address,
): Promise<BacklinkResult> {
  const [metadataAddress] = await findCanonicalPda({ program, seed: PROGRAM_METADATA_SEED });
  try {
  const encoded = await fetchEncodedAccount(rpc, metadataAddress, { commitment: 'finalized' });
  if (!encoded.exists) return { status: 'none', metadataAddress };
  if (encoded.programAddress !== PROGRAM_METADATA_PROGRAM_ID) return { status: 'invalid', metadataAddress, reason: 'wrong metadata owner' };
  const account = decodeMetadata(encoded);
  if (account.programAddress !== PROGRAM_METADATA_PROGRAM_ID) {
    return { status: 'invalid', metadataAddress, reason: 'not owned by the Program Metadata program' };
  }
  const d = account.data;
  if (d.seed !== PROGRAM_METADATA_SEED || d.format !== Format.Json || d.encoding !== Encoding.Utf8 || d.dataLength > LIMITS.proofBytes || d.dataLength > d.data.length) return { status: 'invalid', metadataAddress, reason: 'unsupported or oversized metadata' };
  if (!d.canonical) return { status: 'invalid', metadataAddress, reason: 'metadata account is not canonical' };
  if (d.program !== program) return { status: 'invalid', metadataAddress, reason: 'metadata names another program' };
  if (d.dataSource !== DataSource.Direct) {
    return { status: 'invalid', metadataAddress, reason: 'backlink must use the direct data source' };
  }
  let parsed: unknown;
  try {
    const compressed = Uint8Array.from(d.data.slice(0, d.dataLength));
    let content: Uint8Array;
    if (d.compression === Compression.None) content = compressed;
    else {
      const zlib = await import('node:zlib');
      if (d.compression === Compression.Zlib) content = zlib.inflateSync(compressed, { maxOutputLength: LIMITS.proofBytes });
      else if (d.compression === Compression.Gzip) content = zlib.gunzipSync(compressed, { maxOutputLength: LIMITS.proofBytes });
      else throw new Error('Unsupported compression');
    }
    if (content.length > LIMITS.proofBytes) throw new Error('Backlink too large');
    parsed = parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(content));
  } catch (e) {
    const reason = e instanceof DuplicateKeyError ? `backlink: ${e.message}` : 'backlink content is not JSON';
    return { status: 'invalid', metadataAddress, reason };
  }
  const v = validateProgramLink(parsed);
  if (!v.valid) return { status: 'invalid', metadataAddress, reason: `backlink schema: ${v.errors.join('; ')}` };
  return { status: 'ok', metadataAddress, link: parsed as ProgramLink, mutable: d.mutable };
  } catch { return { status: 'invalid', metadataAddress, reason: 'metadata unavailable or malformed' }; }
}

export function backlinkMatches(result: BacklinkResult, appId: string, appCluster: Cluster): LinkCheck {
  if (result.status === 'none') return { state: 'unverified', detail: 'no canonical oar backlink' };
  if (result.status === 'invalid') return { state: 'failed', detail: result.reason };
  if (result.link.app !== appId || result.link.cluster !== appCluster) {
    return { state: 'failed', method: 'program-metadata', detail: `backlink names ${result.link.app} on ${result.link.cluster}` };
  }
  return { state: 'verified', method: 'program-metadata' };
}

// ---------------------------------------------------------------------------
// Domains: https://<host>/.well-known/oar.json or DNS TXT _oar.<host>
// ---------------------------------------------------------------------------

const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export interface DomainCheckOptions {
  fetch?: typeof fetch;
  /** Defaults to node:dns/promises when available; pass null to skip DNS. */
  resolveTxt?: ((name: string) => Promise<string[][]>) | null;
  timeoutMs?: number;
}

function proofNames(file: ProofFile, appId: string, cluster: Cluster): 'match' | 'other' {
  return file.apps.some(a => a.app_id === appId && a.cluster === cluster) ? 'match' : 'other';
}

async function defaultResolveTxt(): Promise<((name: string) => Promise<string[][]>) | null> {
  try {
    const dns = await import('node:dns/promises');
    return name => dns.resolveTxt(name);
  } catch {
    return null;
  }
}

export async function checkDomain(
  host: string,
  appId: string,
  cluster: Cluster,
  opts: DomainCheckOptions = {},
): Promise<LinkCheck> {
  if (!HOSTNAME.test(host)) return { state: 'failed', detail: 'not a lowercase ASCII hostname' };
  let otherApp = false;
  const notes: string[] = [];

  // 1. Well-known file: HTTPS, 200, <= 16 KiB, no redirects.
  try {
    const text = await readLimitedText(`https://${host}${WELL_KNOWN_PATH}`, {
      fetch: opts.fetch,
      maxBytes: LIMITS.proofBytes,
      timeoutMs: opts.timeoutMs ?? LIMITS.timeoutMs,
      maxRedirects: 0,
    });
    const parsed: unknown = parseJsonStrict(text);
    const v = validateProofFile(parsed);
    if (!v.valid) notes.push(`well-known file invalid: ${v.errors.join('; ')}`);
    else if (proofNames(parsed as ProofFile, appId, cluster) === 'match') return { state: 'verified', method: 'well-known' };
    else otherApp = true;
  } catch (e) {
    notes.push(e instanceof HttpCheckError || e instanceof SyntaxError ? e.message : String(e));
  }

  // 2. DNS TXT at _oar.<host>: "oar=<cluster>:<App ID>".
  const resolveTxt = opts.resolveTxt === undefined ? await defaultResolveTxt() : opts.resolveTxt;
  if (resolveTxt) {
    try {
      const records = (await withDeadline(resolveTxt(`${DNS_LABEL}.${host}`), opts.timeoutMs ?? LIMITS.timeoutMs)).map(chunks => chunks.join(''));
      const oarRecords = records.filter(r => r.startsWith('oar='));
      if (oarRecords.includes(`oar=${cluster}:${appId}`)) return { state: 'verified', method: 'dns-txt' };
      if (oarRecords.length > 0) otherApp = true;
    } catch (e) {
      notes.push(`dns: ${(e as Error).message}`);
    }
  }

  if (otherApp) return { state: 'failed', detail: 'proof names a different App ID or cluster' };
  return { state: 'unverified', detail: notes.join(' | ') || 'no proof found' };
}

// ---------------------------------------------------------------------------
// Repositories: oar.json at the root of the default branch
// ---------------------------------------------------------------------------

/** Raw URL of oar.json on the default branch, for supported forges; null otherwise. */
export function repoProofUrl(repoUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(repoUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null;
  const parts = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (u.hostname === 'github.com' && parts.length === 2) {
    return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/HEAD/${REPO_PROOF_FILE}`;
  }
  if (u.hostname === 'gitlab.com' && parts.length >= 2 && !parts.includes('-')) {
    return `https://gitlab.com/${parts.join('/')}/-/raw/HEAD/${REPO_PROOF_FILE}`;
  }
  return null;
}

export async function checkRepository(
  repoUrl: string,
  appId: string,
  cluster: Cluster,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<LinkCheck> {
  const raw = repoProofUrl(repoUrl);
  if (!raw) return { state: 'unverified', detail: 'unsupported repository host' };
  try {
    const text = await readLimitedText(raw, {
      fetch: opts.fetch,
      maxBytes: LIMITS.proofBytes,
      timeoutMs: opts.timeoutMs ?? LIMITS.timeoutMs,
      maxRedirects: 0,
    });
    const parsed: unknown = parseJsonStrict(text);
    const v = validateProofFile(parsed);
    if (!v.valid) return { state: 'unverified', detail: `oar.json invalid: ${v.errors.join('; ')}` };
    return proofNames(parsed as ProofFile, appId, cluster) === 'match'
      ? { state: 'verified', method: 'repo-file' }
      : { state: 'failed', method: 'repo-file', detail: 'oar.json names a different App ID or cluster' };
  } catch (e) {
    return { state: 'unverified', detail: (e as Error).message };
  }
}

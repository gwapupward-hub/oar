import { fetchEncodedAccount, type Address, type GetAccountInfoApi, type Rpc } from '@solana/kit';
import { APP_RECORD_DISCRIMINATOR, decodeAppRecord, findAppRecordPda, type AppRecord } from './generated/index.js';
import { APP_RECORD_SIZE, MAX_URI_LEN, AppStatus, OAR_PROGRAM_ID, statusName, type AppStatusName, type Cluster } from './constants.js';
import { checkManifest, fetchManifest, type FetchManifestOptions, type ManifestCheck } from './manifest.js';
import { backlinkMatches, checkDomain, checkRepository, fetchProgramBacklink, type LinkCheck } from './links.js';
import { fetchClaimAttestation, type OarSchemaName } from './attestations.js';
import { bytesEqual } from './manifest.js';

type AccountRpc = Rpc<GetAccountInfoApi>;

export type LinkState = 'verified' | 'attested' | 'unverified' | 'failed';

export interface ClaimResult {
  subject: string;
  state: LinkState;
  method?: LinkCheck['method'];
  detail?: string;
  /** Trusted credentials holding a valid, unexpired attestation for this claim. */
  attestedBy: Address[];
}

export interface ProgramClaimResult extends ClaimResult {
  cluster: Cluster;
  name?: string;
}

export type ManifestResult = ManifestCheck | { ok: false; reason: 'unavailable'; errors: string[] };

export interface ResolvedApp {
  appId: Address;
  cluster: Cluster;
  record: AppRecord;
  status: AppStatusName | 'Unknown';
  manifest: ManifestResult;
  programs: ProgramClaimResult[];
  domains: ClaimResult[];
  repositories: ClaimResult[];
}

export interface ResolveOptions extends FetchManifestOptions {
  /** Cluster the `rpc` argument points at. */
  cluster: Cluster;
  /** RPCs for other clusters, to check programs the manifest claims elsewhere. */
  rpcByCluster?: Partial<Record<Cluster, AccountRpc>>;
  /** Run live HTTP/DNS checks for domains and repositories. Default true. */
  live?: boolean;
  /** SAS credentials whose `oar-*` attestations this client trusts. */
  trustedIssuers?: Address[];
  resolveTxt?: ((name: string) => Promise<string[][]>) | null;
  /** Override "now" for attestation expiry (Unix seconds). */
  nowSeconds?: bigint;
}

async function attestationsFor(
  rpc: AccountRpc,
  opts: ResolveOptions,
  schema: OarSchemaName,
  appId: Address,
  subject: string,
  programCluster?: Cluster,
): Promise<Address[]> {
  const out: Address[] = [];
  for (const credential of opts.trustedIssuers ?? []) {
    const a = await fetchClaimAttestation(rpc, { credential, schema, appId, subject, appCluster: opts.cluster, programCluster, nowSeconds: opts.nowSeconds });
    if (a.status === 'valid') out.push(credential);
  }
  return out;
}

/** Combine a live check with attestations: failed wins, then verified, then attested. */
function combine(subject: string, live: LinkCheck | null, attestedBy: Address[]): ClaimResult {
  if (live?.state === 'failed') return { subject, state: 'failed', method: live.method, detail: live.detail, attestedBy };
  if (live?.state === 'verified') return { subject, state: 'verified', method: live.method, attestedBy };
  if (attestedBy.length > 0) return { subject, state: 'attested', detail: live?.detail, attestedBy };
  return { subject, state: 'unverified', detail: live?.detail, attestedBy };
}

/**
 * Resolve an App ID to its record, its manifest (or why the manifest is
 * unusable) and one link state per claim. Returns null if no valid record
 * exists at `appId`.
 */
export async function resolveApp(rpc: AccountRpc, appId: Address, opts: ResolveOptions): Promise<ResolvedApp | null> {
  let record: AppRecord;
  try {
    const encoded = await fetchEncodedAccount(rpc, appId, { commitment: 'finalized' });
    if (!encoded.exists || encoded.programAddress !== OAR_PROGRAM_ID || encoded.data.length !== APP_RECORD_SIZE ||
        !bytesEqual(encoded.data.slice(0, 8), APP_RECORD_DISCRIMINATOR)) return null;
    record = decodeAppRecord(encoded).data;
    if (record.layoutVersion !== 1 || ![0, 1, 2].includes(record.status) ||
        new TextEncoder().encode(record.manifestUri).length > MAX_URI_LEN) return null;
    const [pda, bump] = await findAppRecordPda({ creator: record.creator, nonce: record.nonce });
    if (pda !== appId || bump !== record.bump) return null;
  } catch { return null; }

  const base: ResolvedApp = {
    appId,
    cluster: opts.cluster,
    record,
    status: statusName(record.status),
    manifest: { ok: false, reason: 'unavailable', errors: [] },
    programs: [],
    domains: [],
    repositories: [],
  };

  try {
    const raw = await fetchManifest(record.manifestUri, opts);
    base.manifest = checkManifest(raw, { appId, cluster: opts.cluster, manifestHash: record.manifestHash });
  } catch (e) {
    base.manifest = { ok: false, reason: 'unavailable', errors: [(e as Error).message] };
  }

  // Display rules: a retired app shows no link chips; an invalid manifest has no claims to check.
  if (!base.manifest.ok || record.status === AppStatus.Retired) return base;
  const m = base.manifest.manifest;
  const live = opts.live ?? true;

  for (const p of m.programs ?? []) {
    const programRpc = p.cluster === opts.cluster ? rpc : opts.rpcByCluster?.[p.cluster];
    let check: LinkCheck | null = { state: 'unverified', detail: `no RPC configured for ${p.cluster}` };
    if (programRpc) check = backlinkMatches(await fetchProgramBacklink(programRpc, p.address as Address), appId, opts.cluster);
    const attestedBy = check.state === 'verified' ? [] : await attestationsFor(rpc, opts, 'oar-program', appId, p.address, p.cluster);
    base.programs.push({ ...combine(p.address, check, attestedBy), cluster: p.cluster, name: p.name });
  }

  for (const host of m.domains ?? []) {
    const check = live ? await checkDomain(host, appId, opts.cluster, { fetch: opts.fetch, resolveTxt: opts.resolveTxt }) : null;
    const attestedBy = check?.state === 'verified' ? [] : await attestationsFor(rpc, opts, 'oar-domain', appId, host);
    base.domains.push(combine(host, check, attestedBy));
  }

  for (const repo of m.repositories ?? []) {
    const check = live ? await checkRepository(repo.url, appId, opts.cluster, { fetch: opts.fetch }) : null;
    const attestedBy = check?.state === 'verified' ? [] : await attestationsFor(rpc, opts, 'oar-repo', appId, repo.url);
    base.repositories.push(combine(repo.url, check, attestedBy));
  }

  return base;
}

export interface ResolvedProgram {
  program: Address;
  app: ResolvedApp;
  /** The program's own claim inside the app; `verified` means both sides agree. */
  link: ProgramClaimResult | null;
}

/**
 * Program address -> app. Follows the canonical `oar` backlink, then checks
 * the manifest claims the program back. Wallets SHOULD show the app name only
 * when `link.state === 'verified'`.
 */
export async function resolveProgram(rpc: AccountRpc, program: Address, opts: ResolveOptions): Promise<ResolvedProgram | null> {
  const backlink = await fetchProgramBacklink(rpc, program);
  if (backlink.status !== 'ok') return null;
  const appCluster = backlink.link.cluster;
  const appRpc = appCluster === opts.cluster ? rpc : opts.rpcByCluster?.[appCluster];
  if (!appRpc) return null;

  const app = await resolveApp(appRpc, backlink.link.app as Address, {
    ...opts,
    cluster: appCluster,
    rpcByCluster: { ...opts.rpcByCluster, [opts.cluster]: rpc },
  });
  if (!app) return null;
  const link = app.programs.find(p => p.subject === program && p.cluster === opts.cluster) ?? null;
  return { program, app, link };
}

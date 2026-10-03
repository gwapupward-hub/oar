import canonicalize from 'canonicalize';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import { LIMITS, type Cluster } from './constants.js';
import { manifestSchema, programLinkSchema, wellKnownSchema } from './schemas.js';
import { readLimitedText } from './http.js';

export type Category =
  | 'defi' | 'dex' | 'lending' | 'payments' | 'wallet' | 'nft' | 'marketplace' | 'gaming' | 'social'
  | 'identity' | 'infrastructure' | 'developer-tools' | 'dao' | 'ai-agent' | 'data' | 'depin' | 'media' | 'other';

export interface OarManifest {
  oar: '0.1';
  app_id: string;
  cluster: Cluster;
  name: string;
  summary?: string;
  description?: string;
  icon?: { uri: string; sha256: string; media_type: 'image/png' | 'image/jpeg' | 'image/webp' };
  publisher?: { name: string; url?: string };
  categories: Category[];
  domains?: string[];
  links?: Partial<Record<'website' | 'docs' | 'support' | 'x' | 'discord' | 'telegram' | 'github', string>>;
  repositories?: { url: string; role: 'app' | 'program' | 'sdk' | 'other' }[];
  programs?: { address: string; cluster: Cluster; name?: string; role?: string }[];
  platforms?: {
    web?: { url: string };
    android?: { package: string; dapp_store_app?: string };
    ios?: { app_store_url: string };
  };
  interfaces?: ('wallet-standard' | 'mobile-wallet-adapter' | 'solana-actions' | 'x402')[];
  actions?: { actions_json: string };
  agent?: { registry: 'solana-agent-registry'; id: string };
  security?: {
    contact?: string;
    policy?: string;
    bug_bounty?: string;
    audits?: { auditor: string; report: string; date?: string; programs?: string[] }[];
  };
  extensions?: Record<string, Record<string, unknown>>;
}

export interface ProofFile {
  oar: '0.1';
  apps: { app_id: string; cluster: Cluster }[];
}

export interface ProgramLink {
  oar: '0.1';
  app: string;
  cluster: Cluster;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateManifestSchema = ajv.compile(manifestSchema);
const validateProofSchema = ajv.compile(wellKnownSchema);
const validateLinkSchema = ajv.compile(programLinkSchema);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

/** Spec: manifests MUST NOT contain non-integer numbers (keeps RFC 8785 output trivial). */
function integerOnly(value: unknown, path = ''): string[] {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? [] : [`${path || '/'} must be a safe integer`];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => integerOnly(v, `${path}/${i}`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => integerOnly(v, `${path}/${k}`));
  }
  return [];
}

export function validateManifest(manifest: unknown): ValidationResult {
  const schemaOk = validateManifestSchema(manifest);
  const errors = [...formatErrors(validateManifestSchema.errors), ...integerOnly(manifest)];
  if (schemaOk) {
    const m = manifest as OarManifest;
    if (m.actions) {
      try {
        const u = new URL(m.actions.actions_json);
        if (u.protocol !== 'https:' || u.username || u.password || !m.domains?.includes(u.hostname)) errors.push('/actions must use a listed domain');
      } catch { errors.push('/actions invalid URL'); }
    }
  }
  return { valid: schemaOk && errors.length === 0, errors };
}

export function validateProofFile(value: unknown): ValidationResult {
  const ok = validateProofSchema(value);
  return { valid: ok, errors: formatErrors(validateProofSchema.errors) };
}

export function validateProgramLink(value: unknown): ValidationResult {
  const ok = validateLinkSchema(value);
  return { valid: ok, errors: formatErrors(validateLinkSchema.errors) };
}

/** RFC 8785 (JSON Canonicalization Scheme) bytes. */
export function canonicalizeManifest(manifest: unknown): Uint8Array {
  const text = canonicalize(manifest);
  if (text === undefined) throw new Error('Manifest cannot be canonicalized');
  return new TextEncoder().encode(text);
}

/** manifest_hash = SHA-256(RFC 8785 canonical bytes). */
export function hashManifest(manifest: unknown): Uint8Array {
  return sha256(canonicalizeManifest(manifest));
}

export function hashManifestHex(manifest: unknown): string {
  return bytesToHex(hashManifest(manifest));
}

export function bytesEqual(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface FetchManifestOptions {
  fetch?: typeof fetch;
  /** Gateway for ar:// URIs. Default https://arweave.net/ */
  arweaveGateway?: string;
  /** Gateway for ipfs:// URIs. Default https://ipfs.io/ipfs/ */
  ipfsGateway?: string;
  timeoutMs?: number;
}

/** Map ar:// and ipfs:// to HTTPS gateways; reject any other scheme. */
export function manifestUriToUrl(uri: string, opts: FetchManifestOptions = {}): string {
  if (uri.startsWith('https://')) return uri;
  if (uri.startsWith('ar://')) return (opts.arweaveGateway ?? 'https://arweave.net/') + uri.slice(5);
  if (uri.startsWith('ipfs://')) return (opts.ipfsGateway ?? 'https://ipfs.io/ipfs/') + uri.slice(7);
  throw new Error(`Unsupported manifest URI scheme: ${uri}`);
}

/** Fetch and parse a manifest (size and time limited). Integrity is checked separately against the record. */
export async function fetchManifest(uri: string, opts: FetchManifestOptions = {}): Promise<unknown> {
  const url = manifestUriToUrl(uri, opts);
  const text = await readLimitedText(url, {
    fetch: opts.fetch,
    maxBytes: LIMITS.manifestBytes,
    timeoutMs: opts.timeoutMs ?? LIMITS.timeoutMs,
    maxRedirects: LIMITS.manifestRedirects,
  });
  return JSON.parse(text);
}

export type ManifestCheck =
  | { ok: true; manifest: OarManifest }
  | { ok: false; reason: 'hash-mismatch' | 'schema' | 'app-id-mismatch' | 'cluster-mismatch'; errors?: string[] };

/** All validity rules from the spec's Manifest section, given the record's address, cluster and hash. */
export function checkManifest(
  manifest: unknown,
  expected: { appId: string; cluster: Cluster; manifestHash: ArrayLike<number> },
): ManifestCheck {
  if (!bytesEqual(hashManifest(manifest), expected.manifestHash)) return { ok: false, reason: 'hash-mismatch' };
  const v = validateManifest(manifest);
  if (!v.valid) return { ok: false, reason: 'schema', errors: v.errors };
  const m = manifest as OarManifest;
  if (m.app_id !== expected.appId) return { ok: false, reason: 'app-id-mismatch' };
  if (m.cluster !== expected.cluster) return { ok: false, reason: 'cluster-mismatch' };
  return { ok: true, manifest: m };
}

export function buildProgramLink(appId: string, cluster: Cluster): ProgramLink {
  return { oar: '0.1', app: appId, cluster };
}

export function buildProofFile(apps: { appId: string; cluster: Cluster }[]): ProofFile {
  return { oar: '0.1', apps: apps.map(a => ({ app_id: a.appId, cluster: a.cluster })) };
}

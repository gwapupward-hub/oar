// Shared helpers for the devnet operator scripts.
// These scripts pass keypair PATHS to the Solana CLIs and never read, print or copy signer bytes.
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEFAULT_RPC = 'https://api.devnet.solana.com';
export const EXPOSED_ID = 'oarWKQoXgxp69Vupf883Pr1PvN35rAyZJeFu8q4pae5';
export const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const RELEASE_FILE = join(root, 'release', 'devnet.json');

/** Loader-v3 account sizes: program account, ProgramData header, buffer header. */
export const PROGRAM_ACCOUNT_BYTES = 36;
export const PROGRAMDATA_HEADER_BYTES = 45;
export const BUFFER_HEADER_BYTES = 37;
/** Rent-exempt minimum under the current rent parameters (3480 lamports/byte-year, 2 years, 128-byte overhead). */
export const rentExempt = bytes => (BigInt(bytes) + 128n) * 6960n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const sol = lamports => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Executable hash: SHA-256 of the program bytes with trailing zero padding removed.
 * Same method as `solana-verify get-executable-hash` / `get-program-hash`, so a local
 * artifact and a `solana program dump` of the deployed ProgramData compare equal.
 */
export function executableHash(bytes) {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return sha256(bytes.subarray(0, end));
}

/** Host only, so RPC credentials in paths or query strings never reach logs or records. */
export function rpcHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

export function declaredProgramId() {
  const src = readFileSync(join(root, 'programs/oar-registry/src/lib.rs'), 'utf8');
  return src.match(/declare_id!\("([^"]+)"\)/)?.[1];
}

/** Run a command and return trimmed stdout; throws with stderr on a nonzero exit. */
export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

/** Like run(), but returns { ok, stdout, stderr } instead of throwing. */
export function tryRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...opts });
  if (r.error) return { ok: false, stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

export const pubkeyOf = keypairPath => run('solana-keygen', ['pubkey', keypairPath]);

/** Agave prints e.g. "solana-cli 4.2.2 (src:...; feat:..., client:Agave)". */
export function parseSolanaVersion(text) {
  return text.match(/solana-cli\s+(\S+)/)?.[1] ?? null;
}

export const isPrerelease = version => /(rc|beta|alpha|pre|dev)/i.test(version ?? '');

/** Every flag must appear in the installed CLI's --help before a command relies on it. */
export function missingFlags(helpText, flags) {
  return flags.filter(f => !new RegExp(`(^|[\\s,])${f.replace(/[-]/g, '\\-')}(?=[\\s,=<]|$)`, 'm').test(helpText));
}

/** Deterministic key order, so two JSON documents compare by content. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fail(message) {
  console.error(`\nSTOP: ${message}`);
  process.exit(1);
}

export function report(title, rows) {
  console.log(`\n${title}`);
  const width = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(width)}  ${v}`);
}

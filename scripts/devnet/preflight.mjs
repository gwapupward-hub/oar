// Read-only devnet release preflight. Sends no transactions.
//
//   node scripts/devnet/preflight.mjs --artifact-dir <ci-artifact-dir> \
//     --upgrade-authority <path> --payer <path> [--program-keypair <path>] [--rpc <url>]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  BUFFER_HEADER_BYTES,
  DEFAULT_RPC,
  DEVNET_GENESIS,
  EXPOSED_ID,
  LAMPORTS_PER_SOL,
  PROGRAMDATA_HEADER_BYTES,
  PROGRAM_ACCOUNT_BYTES,
  RELEASE_FILE,
  UPGRADEABLE_LOADER,
  declaredProgramId,
  executableHash,
  fail,
  isPrerelease,
  parseSolanaVersion,
  pubkeyOf,
  readJson,
  rentExempt,
  report,
  root,
  rpcHost,
  run,
  sha256,
  sol,
  tryRun,
} from './lib.mjs';

/** Paths whose change since the artifact's commit means the artifact no longer matches source. */
export const PROGRAM_PATHS = ['programs', 'Cargo.toml', 'Cargo.lock'];
export const MARGIN_LAMPORTS = LAMPORTS_PER_SOL / 20n;

export const OPTIONS = {
  rpc: { type: 'string', default: DEFAULT_RPC },
  'artifact-dir': { type: 'string' },
  'program-keypair': { type: 'string' },
  'upgrade-authority': { type: 'string' },
  payer: { type: 'string' },
  json: { type: 'boolean', default: false },
};

/** Collect every fact the gate needs. All reads; no transactions. */
export function gather(opts) {
  const artifactDir = opts['artifact-dir'];
  const facts = { rpcHost: rpcHost(opts.rpc), declaredId: declaredProgramId() };

  const cli = tryRun('solana', ['--version']);
  facts.cliVersion = cli.ok ? parseSolanaVersion(cli.stdout) : null;
  const verify = tryRun('solana-verify', ['--version']);
  facts.verifyVersion = verify.ok ? verify.stdout.split(/\s+/).pop() : null;

  const genesis = tryRun('solana', ['genesis-hash', '-u', opts.rpc]);
  facts.genesis = genesis.ok ? genesis.stdout : null;

  facts.release = existsSync(RELEASE_FILE) ? readJson(RELEASE_FILE) : null;
  const metaPath = join(artifactDir, 'build-metadata.json');
  const soPath = join(artifactDir, 'oar_registry.so');
  facts.metadata = existsSync(metaPath) ? readJson(metaPath) : null;
  if (existsSync(soPath)) {
    const bytes = readFileSync(soPath);
    facts.artifact = { path: soPath, bytes: bytes.length, sha256: sha256(bytes), executableHash: executableHash(bytes) };
  }
  facts.idlSha256 = sha256(readFileSync(join(root, 'idl/oar_registry.json')));

  facts.git = { clean: run('git', ['status', '--porcelain']) === '', head: run('git', ['rev-parse', 'HEAD']) };
  const commit = facts.metadata?.repo_sha;
  if (commit) {
    facts.git.artifactCommitIsAncestor = tryRun('git', ['merge-base', '--is-ancestor', commit, 'HEAD']).ok;
    facts.git.programPathsChanged = !tryRun('git', ['diff', '--quiet', commit, 'HEAD', '--', ...PROGRAM_PATHS]).ok;
  }

  const source = tryRun(process.execPath, ['scripts/check-release.mjs']);
  facts.sourceCheck = { ok: source.ok, output: source.ok ? source.stdout : source.stderr };

  facts.keys = {
    program: opts['program-keypair'] ? pubkeyOf(opts['program-keypair']) : null,
    authority: opts['upgrade-authority'] ? pubkeyOf(opts['upgrade-authority']) : null,
    payer: opts.payer ? pubkeyOf(opts.payer) : null,
  };

  if (facts.genesis === DEVNET_GENESIS && facts.declaredId) {
    const show = tryRun('solana', ['program', 'show', facts.declaredId, '-u', opts.rpc, '--output', 'json']);
    if (show.ok) facts.onchain = { exists: true, show: JSON.parse(show.stdout) };
    else if (/Unable to find the account/i.test(show.stderr + show.stdout)) facts.onchain = { exists: false };
    else facts.onchain = { error: show.stderr || show.stdout };
    if (facts.keys.payer) {
      const bal = tryRun('solana', ['balance', facts.keys.payer, '--lamports', '-u', opts.rpc]);
      facts.payerLamports = bal.ok ? BigInt(bal.stdout.match(/^\d+/)?.[0] ?? '0') : null;
    }
  }
  return facts;
}

/** Pure release gate over gathered facts. Every failure is a stop condition. */
export function evaluate(f) {
  const failures = [];
  const warnings = [];
  const no = msg => failures.push(msg);

  if (!f.cliVersion) no('Solana CLI (`solana`) not found');
  else if (isPrerelease(f.cliVersion)) no(`Solana CLI ${f.cliVersion} is a prerelease; install a stable Agave release`);
  if (!f.verifyVersion) warnings.push('solana-verify not installed: the onchain hash is checked with the built-in method only');

  if (f.genesis !== DEVNET_GENESIS) no(`RPC ${f.rpcHost} is not devnet (genesis ${f.genesis ?? 'unreachable'})`);

  if (!f.declaredId) no('declare_id! not found in programs/oar-registry/src/lib.rs');
  if (f.declaredId === EXPOSED_ID) no('Source still declares the exposed reference program ID');
  if (!f.sourceCheck?.ok) no(`Identity/secret source check failed: ${f.sourceCheck?.output}`);

  const r = f.release;
  if (!r) no('release/devnet.json missing');
  else if (!/^.+@sha256:[0-9a-f]{64}$/.test(r.builderImage ?? '')) no('release/devnet.json builderImage is not digest-pinned');

  const m = f.metadata;
  if (!m) no('build-metadata.json missing from the artifact directory (download the CI artifact, not a local build)');
  if (!f.artifact) no('oar_registry.so missing from the artifact directory');
  if (m && f.artifact) {
    if (m.program_id !== f.declaredId) no(`Artifact was built for ${m.program_id}, source declares ${f.declaredId}`);
    if (r && m.builder_image !== r.builderImage) no(`Artifact builder ${m.builder_image} differs from pinned ${r.builderImage}`);
    if (m.artifact_sha256 !== f.artifact.sha256) no('Artifact SHA-256 does not match its build metadata');
    if (m.executable_hash !== f.artifact.executableHash) no('Artifact executable hash does not match its build metadata');
    if (m.idl_sha256 !== f.idlSha256) no('idl/oar_registry.json differs from the IDL built with the artifact');
    if (m.double_build_match !== true) no('Build metadata does not record an identical second clean build');
  }

  if (!f.git.clean) no('Working tree is dirty; commit or stash before a release');
  if (m?.repo_sha) {
    if (!f.git.artifactCommitIsAncestor) no(`Artifact commit ${m.repo_sha} is not in this checkout's history (fetch full history or check out the release branch)`);
    if (f.git.programPathsChanged) no(`Program source changed since artifact commit ${m.repo_sha}; rebuild in CI`);
  }

  const { program, authority, payer } = f.keys;
  if (!authority) no('--upgrade-authority is required');
  if (!payer) no('--payer is required');
  if (authority && payer && authority === payer) no('Upgrade authority and fee payer must be different keys');
  for (const [name, key] of [['upgrade authority', authority], ['fee payer', payer]]) {
    if (key && key === f.declaredId) no(`The ${name} must not be the program ID key`);
    if (key === EXPOSED_ID) no(`The ${name} is the exposed reference key`);
  }

  let mode = null;
  let requiredLamports = null;
  const bytes = BigInt(f.artifact?.bytes ?? 0);
  if (f.onchain?.error) no(`Could not read the program account: ${f.onchain.error}`);
  else if (f.onchain?.exists === false) {
    mode = 'fresh';
    if (!program) no('--program-keypair is required for the first deployment');
    else if (program !== f.declaredId) no(`Program keypair is ${program}, source declares ${f.declaredId}`);
    requiredLamports =
      rentExempt(PROGRAM_ACCOUNT_BYTES) + rentExempt(BigInt(PROGRAMDATA_HEADER_BYTES) + bytes) + rentExempt(BigInt(BUFFER_HEADER_BYTES) + bytes) + MARGIN_LAMPORTS;
  } else if (f.onchain?.exists) {
    mode = 'upgrade';
    const s = f.onchain.show;
    if (s.owner !== UPGRADEABLE_LOADER) no(`Program owner is ${s.owner}, expected the upgradeable loader`);
    if (!s.authority || s.authority === 'none') no('Program is immutable; it cannot be upgraded');
    else if (s.authority !== authority) no(`Onchain upgrade authority is ${s.authority}, not the supplied ${authority}`);
    requiredLamports = rentExempt(BigInt(BUFFER_HEADER_BYTES) + bytes) + MARGIN_LAMPORTS;
    const allocated = BigInt(s.dataLen ?? 0);
    if (bytes > allocated) {
      requiredLamports += rentExempt(BigInt(PROGRAMDATA_HEADER_BYTES) + bytes) - rentExempt(BigInt(PROGRAMDATA_HEADER_BYTES) + allocated);
      warnings.push(`Artifact (${bytes} B) is larger than ProgramData (${allocated} B); the upgrade must extend it`);
    }
  }
  if (requiredLamports !== null && f.payerLamports !== undefined) {
    if (f.payerLamports === null) no('Could not read the fee payer balance');
    else if (f.payerLamports < requiredLamports) no(`Fee payer holds ${sol(f.payerLamports)}; needs at least ${sol(requiredLamports)}`);
  }

  return { ok: failures.length === 0, failures, warnings, mode, requiredLamports };
}

export function printSummary(f, verdict) {
  report('Devnet release preflight', [
    ['RPC', `${f.rpcHost} (genesis ${f.genesis ?? 'unreachable'})`],
    ['Solana CLI', f.cliVersion ?? 'missing'],
    ['solana-verify', f.verifyVersion ?? 'missing'],
    ['Program ID', f.declaredId ?? 'missing'],
    ['Mode', verdict.mode ?? 'unknown'],
    ['Artifact commit', f.metadata?.repo_sha ?? 'unknown'],
    ['Checkout HEAD', f.git.head],
    ['Builder', f.metadata?.builder_image ?? 'unknown'],
    ['Artifact SHA-256', f.artifact?.sha256 ?? 'missing'],
    ['Executable hash', f.artifact?.executableHash ?? 'missing'],
    ['Artifact bytes', String(f.artifact?.bytes ?? 'missing')],
    ['Upgrade authority', f.keys.authority ?? 'missing'],
    ['Fee payer', f.keys.payer ?? 'missing'],
    ['Payer balance', f.payerLamports == null ? 'unknown' : sol(f.payerLamports)],
    ['Required (est.)', verdict.requiredLamports == null ? 'unknown' : sol(verdict.requiredLamports)],
  ]);
  for (const w of verdict.warnings) console.log(`  WARN  ${w}`);
  for (const x of verdict.failures) console.log(`  FAIL  ${x}`);
  console.log(verdict.ok ? '\nPREFLIGHT PASSED' : `\nPREFLIGHT FAILED (${verdict.failures.length})`);
}

export function preflight(opts) {
  if (!opts['artifact-dir']) fail('--artifact-dir is required (the downloaded CI artifact directory)');
  const facts = gather(opts);
  const verdict = evaluate(facts);
  return { facts, verdict };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: OPTIONS });
  const { facts, verdict } = preflight(values);
  if (values.json) console.log(JSON.stringify({ facts, verdict }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  else printSummary(facts, verdict);
  process.exit(verdict.ok ? 0 : 1);
}

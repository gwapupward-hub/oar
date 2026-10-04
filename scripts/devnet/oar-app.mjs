// Register OAR itself on devnet: one App ID whose manifest claims the OAR program and this repository,
// with the program's canonical `oar` backlink, so wallets can verify both directions.
//
//   node scripts/devnet/oar-app.mjs prepare [--creator <PUBKEY>]
//       Writes release/devnet/oar.manifest.json and the repo proof oar.json (public data only).
//   node scripts/devnet/oar-app.mjs publish --payer <path> --upgrade-authority <path> --confirm <APP_ID> [--rpc <url>]
//       After those files are on the public default branch: register, write the backlink, resolve, record evidence.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_RPC, DEVNET_GENESIS, declaredProgramId, fail, pubkeyOf, readJson, report, root, rpcHost, run, tryRun, writeJson } from './lib.mjs';
import { loadRecord, saveRecord } from './record.mjs';

export const REPO = 'https://github.com/gwapupward-hub/oar';
export const MANIFEST_PATH = 'release/devnet/oar.manifest.json';
export const PROOF_PATH = 'oar.json';
export const NONCE = 0n;
const CLUSTER = 'solana:devnet';
const CLI = join(root, 'packages/cli/dist/index.js');
const PM = join(root, 'node_modules', '.bin', 'program-metadata');

/** Commit-pinned raw URL: immutable bytes for the onchain manifest hash. */
export function manifestUri(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Not a full commit SHA: ${commit}`);
  return `https://raw.githubusercontent.com/gwapupward-hub/oar/${commit}/${MANIFEST_PATH}`;
}

export function buildManifest({ appId, programId }) {
  return {
    oar: '0.1',
    app_id: appId,
    cluster: CLUSTER,
    name: 'Open App Registry',
    summary: 'Onchain application identity for Solana: one App ID per app, with every link proven from both sides.',
    categories: ['infrastructure', 'identity'],
    publisher: { name: 'GWAP' },
    links: { github: 'https://github.com/gwapupward-hub' },
    repositories: [{ url: REPO, role: 'program' }],
    programs: [{ address: programId, cluster: CLUSTER, name: 'OAR Registry', role: 'registry' }],
    security: {
      contact: `${REPO}/security/advisories/new`,
      policy: `${REPO}/blob/main/SECURITY.md`,
    },
  };
}

/** Lazy import so `prepare` and the unit tests can load this module without a built SDK. */
const sdk = () => import('@open-app-registry/sdk');

async function prepare(o) {
  const { findAppId, validateManifest, validateProofFile, buildProofFile, hashManifestHex } = await sdk();
  const r = loadRecord();
  const creator = o.creator ?? r.deployment?.feePayer;
  if (!creator) fail('--creator is required (no deployment.feePayer in release/devnet.json)');
  const programId = declaredProgramId();
  const appId = await findAppId({ creator, nonce: NONCE });
  const manifest = buildManifest({ appId, programId });
  const mv = validateManifest(manifest);
  if (!mv.valid) fail(`Generated manifest is invalid: ${mv.errors.join('; ')}`);
  const proof = buildProofFile([{ appId, cluster: CLUSTER }]);
  const pv = validateProofFile(proof);
  if (!pv.valid) fail(`Generated proof file is invalid: ${pv.errors.join('; ')}`);
  mkdirSync(join(root, 'release/devnet'), { recursive: true });
  writeJson(join(root, MANIFEST_PATH), manifest);
  writeJson(join(root, PROOF_PATH), proof);
  report('OAR App ID (devnet)', [
    ['App ID', appId],
    ['Creator', `${creator} (nonce ${NONCE})`],
    ['Program', programId],
    ['Manifest', `${MANIFEST_PATH} (sha256 ${hashManifestHex(manifest)})`],
    ['Repo proof', PROOF_PATH],
  ]);
  console.log('\nCommit both files to the default branch of the PUBLIC repository, then run `publish`.');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function publish(o) {
  const s = await sdk();
  const { createSolanaRpc, address } = await import('@solana/kit');
  for (const k of ['payer', 'upgrade-authority', 'confirm']) if (!o[k]) fail(`--${k} is required`);
  if (!existsSync(CLI)) fail('Build first: npm run build');
  const r = loadRecord();
  const programId = declaredProgramId();
  if (!r.deployment?.hashVerified || r.programId !== programId) fail('release/devnet.json has no verified deployment of the declared program');
  if (run('solana', ['genesis-hash', '-u', o.rpc]) !== DEVNET_GENESIS) fail(`RPC ${rpcHost(o.rpc)} is not devnet`);

  const manifest = readJson(join(root, MANIFEST_PATH));
  const proof = readJson(join(root, PROOF_PATH));
  const payer = pubkeyOf(o.payer);
  const authority = pubkeyOf(o['upgrade-authority']);
  const appId = await s.findAppId({ creator: address(payer), nonce: NONCE });
  if (manifest.app_id !== appId) fail(`Manifest app_id ${manifest.app_id} is not ${appId}, derived from the payer ${payer} and nonce ${NONCE}; re-run prepare with --creator ${payer}`);
  if (o.confirm !== appId) fail(`Pass --confirm ${appId} to register it on devnet.`);
  if (!proof.apps?.some(a => a.app_id === appId && a.cluster === CLUSTER)) fail(`${PROOF_PATH} does not name ${appId} on ${CLUSTER}`);
  const show = JSON.parse(run('solana', ['program', 'show', programId, '-u', o.rpc, '--output', 'json']));
  if (show.authority !== authority) fail(`The backlink must be signed by the upgrade authority ${show.authority}, not ${authority}`);

  // The onchain hash must commit to bytes anyone can fetch: pin the URI to a public commit and fetch it as wallets do.
  if (run('git', ['status', '--porcelain', '--', MANIFEST_PATH, PROOF_PATH]) !== '') fail(`${MANIFEST_PATH} or ${PROOF_PATH} has uncommitted changes`);
  const commit = run('git', ['log', '-1', '--format=%H', '--', MANIFEST_PATH]);
  const uri = manifestUri(commit);
  const localHash = s.hashManifestHex(manifest);
  let hosted;
  try {
    hosted = await s.fetchManifest(uri);
  } catch (e) {
    fail(`Cannot fetch ${uri} (${e.message}). Push the commit and make the repository public first.`);
  }
  if (s.hashManifestHex(hosted) !== localHash) fail(`Hosted manifest at ${uri} differs from ${MANIFEST_PATH}`);
  const repoCheck = await s.checkRepository(REPO, appId, CLUSTER);
  if (repoCheck.state !== 'verified') fail(`Repository proof not served yet (${repoCheck.detail ?? repoCheck.state}). ${PROOF_PATH} must be on the public default branch.`);

  const rpc = createSolanaRpc(o.rpc);
  const net = ['-c', 'devnet', '-u', o.rpc];
  const out = { appId, creator: payer, nonce: Number(NONCE), uri, manifestSha256: localHash, commit, steps: [] };

  // 1. AppRecord: register, or accept an identical existing record (idempotent re-run).
  const existing = await s.fetchMaybeAppRecord(rpc, address(appId));
  if (existing.exists) {
    const same = existing.data.manifestUri === uri && Buffer.from(existing.data.manifestHash).toString('hex') === localHash;
    if (!same) fail(`${appId} already exists with a different manifest (${existing.data.manifestUri}); use \`oar update\` deliberately`);
    out.steps.push({ step: 'register', skipped: 'identical record exists' });
  } else {
    const reg = tryRun(process.execPath, [CLI, 'register', '-m', MANIFEST_PATH, '--uri', uri, '--nonce', String(NONCE), ...net, '-k', o.payer]);
    if (!reg.ok) fail(`register failed: ${reg.stderr || reg.stdout}`);
    out.steps.push({ step: 'register', signature: reg.stdout.match(/Signature (\w+)/)?.[1] ?? null });
  }

  // 2. Canonical `oar` backlink on the program, written by its upgrade authority.
  const backlink = await s.fetchProgramBacklink(rpc, address(programId));
  if (backlink.status === 'ok' && backlink.link.app === appId && backlink.link.cluster === CLUSTER) {
    out.steps.push({ step: 'backlink', skipped: 'identical backlink exists', metadata: backlink.metadataAddress });
  } else if (backlink.status === 'ok' || backlink.status === 'invalid') {
    fail(`The program already has an \`oar\` metadata account (${backlink.metadataAddress}) that names something else; replacing it is a separate decision`);
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'oar-link-'));
    try {
      const file = join(dir, 'oar-link.json');
      writeFileSync(file, JSON.stringify(s.buildProgramLink(appId, CLUSTER)));
      const w = tryRun(PM, ['write', 'oar', programId, file, '--format', 'json', '-k', o['upgrade-authority'], '-p', o.payer, '--rpc', o.rpc]);
      if (!w.ok) fail(`program-metadata write failed: ${w.stderr || w.stdout}`);
      out.steps.push({ step: 'backlink', metadata: backlink.metadataAddress, output: w.stdout.split('\n').filter(Boolean).slice(-3) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // 3. Resolve exactly as a wallet would. The SDK reads finalized state, so allow time to finalize.
  let resolved = null;
  for (let i = 0; i < 20; i++) {
    resolved = await s.resolveProgram(rpc, address(programId), { cluster: CLUSTER });
    if (resolved?.link?.state === 'verified' && resolved.app.repositories[0]?.state === 'verified') break;
    await sleep(3000);
  }
  const app = resolved?.app;
  out.resolved = resolved && {
    link: resolved.link?.state ?? null,
    manifest: app.manifest.ok ? 'ok' : app.manifest.reason,
    status: app.status,
    programs: app.programs.map(p => ({ subject: p.subject, state: p.state, method: p.method ?? null })),
    repositories: app.repositories.map(p => ({ subject: p.subject, state: p.state, method: p.method ?? null })),
  };
  out.pass = resolved?.link?.state === 'verified' && app.manifest.ok && app.status === 'Active' &&
    app.programs.every(p => p.state === 'verified') && app.repositories.every(p => p.state === 'verified');
  out.at = new Date().toISOString();
  out.rpcHost = rpcHost(o.rpc);

  mkdirSync(join(root, 'release/evidence'), { recursive: true });
  const evidence = join(root, 'release/evidence', `devnet-oar-app-${out.at.slice(0, 10)}-${appId.slice(0, 8)}.json`);
  writeJson(evidence, out);
  r.oarApp = { appId, uri, manifestSha256: localHash, pass: out.pass, evidence: relative(root, evidence), at: out.at };
  saveRecord(r);
  report('OAR on devnet', [
    ['App ID', appId],
    ['Program link', out.resolved?.link ?? 'not resolved'],
    ['Manifest', out.resolved?.manifest ?? 'unavailable'],
    ['Repository', out.resolved?.repositories?.[0]?.state ?? 'unknown'],
    ['Evidence', relative(root, evidence)],
  ]);
  if (!out.pass) fail('Self-registration did not verify end to end; see the evidence file.');
  console.log(`\nVERIFIED: \`oar resolve-program ${programId} -c devnet\` now names Open App Registry.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      creator: { type: 'string' },
      payer: { type: 'string' },
      'upgrade-authority': { type: 'string' },
      confirm: { type: 'string' },
      rpc: { type: 'string', default: DEFAULT_RPC },
    },
  });
  const cmd = { prepare, publish }[positionals[0]];
  if (!cmd) fail('Usage: oar-app.mjs prepare | publish (see the header comment)');
  cmd(o).catch(e => fail(e.message));
}

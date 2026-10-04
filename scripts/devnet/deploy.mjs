// Guarded devnet deploy/upgrade of the exact CI artifact, then onchain verification.
//
//   node scripts/devnet/deploy.mjs --artifact-dir <ci-artifact-dir> \
//     --upgrade-authority <path> --payer <path> [--program-keypair <path>] \
//     --confirm <PROGRAM_ID> [--rpc <url>] [--compute-unit-price <micro-lamports>]
//
// Never closes buffers, never passes --final, never generates keys.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { UPGRADEABLE_LOADER, executableHash, fail, missingFlags, report, root, run, tryRun } from './lib.mjs';
import { OPTIONS, preflight, printSummary } from './preflight.mjs';
import { loadRecord, saveRecord } from './record.mjs';

export const DEPLOY_FLAGS = ['--program-id', '--upgrade-authority', '--keypair', '--url', '--use-rpc', '--with-compute-unit-price', '--max-sign-attempts', '--output'];

export function deployArgs({ soPath, mode, programKeypair, programId, authority, payer, rpc, computeUnitPrice }) {
  return [
    'program', 'deploy', soPath,
    '--program-id', mode === 'fresh' ? programKeypair : programId,
    '--upgrade-authority', authority,
    '--keypair', payer,
    '--url', rpc,
    '--use-rpc',
    '--with-compute-unit-price', String(computeUnitPrice),
    '--max-sign-attempts', '50',
    '--output', 'json',
  ];
}

/** `--output json` prints one JSON object; progress goes to stderr. */
export function parseDeployOutput(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) return {};
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return {};
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { values: o } = parseArgs({
    options: { ...OPTIONS, confirm: { type: 'string' }, 'compute-unit-price': { type: 'string', default: '10000' } },
  });
  const { facts, verdict } = preflight(o);
  printSummary(facts, verdict);
  if (!verdict.ok) fail('Preflight failed; nothing was sent.');
  const id = facts.declaredId;
  if (o.confirm !== id) fail(`Pass --confirm ${id} to authorize this ${verdict.mode} deployment on devnet.`);
  if (!/^\d+$/.test(o['compute-unit-price'])) fail('--compute-unit-price must be an integer (micro-lamports per CU)');

  const help = run('solana', ['program', 'deploy', '--help']);
  const missing = missingFlags(help, DEPLOY_FLAGS);
  if (missing.length) fail(`Installed Solana CLI lacks: ${missing.join(', ')}. Use a stable Agave release that supports them.`);

  const previousSlot = facts.onchain.show?.lastDeploySlot ?? null;
  const args = deployArgs({
    soPath: facts.artifact.path,
    mode: verdict.mode,
    programKeypair: o['program-keypair'],
    programId: id,
    authority: o['upgrade-authority'],
    payer: o.payer,
    rpc: o.rpc,
    computeUnitPrice: o['compute-unit-price'],
  });
  console.log(`\nDeploying ${facts.artifact.sha256} to ${id} (${verdict.mode}) on devnet...`);
  // stdout is captured for the JSON result; stderr (progress, and any buffer-recovery phrase) stays on the
  // operator's terminal only and is never written to disk.
  const res = spawnSync('solana', args, { cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (res.status !== 0) {
    console.log(res.stdout);
    const authority = facts.keys.authority;
    fail(
      `Deploy failed (exit ${res.status}). Preserve the error above. A partial upload may have left a buffer:\n` +
        `  solana program show --buffers --buffer-authority ${authority} -u <RPC>\n` +
        'Resume with --buffer <recovered buffer keypair>, or close the buffer only as a separate decision. Do not generate a new program keypair.',
    );
  }
  const out = parseDeployOutput(res.stdout);

  // A deployment becomes visible in the next slot; wait for show to reflect it.
  let show;
  for (let i = 0; i < 30; i++) {
    const s = tryRun('solana', ['program', 'show', id, '-u', o.rpc, '--output', 'json']);
    if (s.ok) {
      show = JSON.parse(s.stdout);
      const slot = Number(run('solana', ['slot', '-u', o.rpc]));
      if (show.lastDeploySlot && show.lastDeploySlot !== previousSlot && slot > show.lastDeploySlot) break;
    }
    show = undefined;
    await sleep(2000);
  }
  if (!show) fail('Program not visible with a new deployment slot after 60s. Check `solana program show` before retrying anything.');

  const problems = [];
  if (show.owner !== UPGRADEABLE_LOADER) problems.push(`owner ${show.owner}`);
  if (show.authority !== facts.keys.authority) problems.push(`upgrade authority ${show.authority}`);

  const dir = mkdtempSync(join(tmpdir(), 'oar-dump-'));
  let onchainHash;
  try {
    run('solana', ['program', 'dump', id, join(dir, 'onchain.so'), '-u', o.rpc]);
    onchainHash = executableHash(readFileSync(join(dir, 'onchain.so')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (onchainHash !== facts.artifact.executableHash) problems.push(`onchain executable hash ${onchainHash}`);
  let verifyHash = null;
  if (facts.verifyVersion) {
    const v = tryRun('solana-verify', ['get-program-hash', '-u', o.rpc, id]);
    verifyHash = v.ok ? v.stdout.match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase() ?? null : null;
    if (verifyHash !== facts.artifact.executableHash) problems.push(`solana-verify program hash ${verifyHash ?? v.stderr}`);
  }

  const r = loadRecord();
  if (r.deployment) r.history = [...(r.history ?? []), { deployment: r.deployment, build: r.build, idl: r.idl, smoke: r.smoke }];
  const m = facts.metadata;
  r.programId = id;
  r.build = m;
  r.deployment = {
    mode: verdict.mode,
    programDataAddress: show.programdataAddress,
    slot: show.lastDeploySlot,
    previousSlot,
    dataLen: show.dataLen,
    signature: out.signature ?? null,
    upgradeAuthority: show.authority,
    feePayer: facts.keys.payer,
    onchainExecutableHash: onchainHash,
    solanaVerifyProgramHash: verifyHash,
    hashVerified: problems.length === 0,
    operatorCheckout: facts.git.head,
    solanaCli: facts.cliVersion,
    solanaVerify: facts.verifyVersion,
    rpcHost: facts.rpcHost,
    deployedAt: new Date().toISOString(),
  };
  // IDL and smoke evidence belong to one artifact; a new deployment must re-earn them.
  r.idl = null;
  r.smoke = null;
  saveRecord(r);

  report('Deployment', [
    ['Program ID', id],
    ['ProgramData', show.programdataAddress],
    ['Slot', String(show.lastDeploySlot)],
    ['Signature', out.signature ?? 'not reported by CLI'],
    ['Upgrade authority', show.authority],
    ['Onchain hash', onchainHash],
    ['Expected hash', facts.artifact.executableHash],
  ]);
  if (problems.length) fail(`Post-deploy verification FAILED: ${problems.join('; ')}. Recorded in release/devnet.json; do not proceed.`);
  console.log('\nVERIFIED. Next: scripts/devnet/publish-idl.mjs, then scripts/devnet/smoke.mjs, then commit release/.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => fail(e.message));

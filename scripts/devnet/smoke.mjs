// Devnet smoke suite: the full AppRecord lifecycle plus negative cases, through the real `oar` CLI.
//
//   node scripts/devnet/smoke.mjs --payer <path> [--rpc <url>]
//
// The payer creates and first owns a throwaway test App ID. A second, ephemeral devnet-only key
// (created in the OS temp dir, swept and deleted afterwards) takes over authority.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createSolanaRpc, signature as toSignature } from '@solana/kit';
import { DEFAULT_RPC, DEVNET_GENESIS, declaredProgramId, fail, pubkeyOf, report, root, rpcHost, run, tryRun, writeJson } from './lib.mjs';
import { loadRecord, saveRecord } from './record.mjs';

const CLI = join(root, 'packages/cli/dist/index.js');
const URI = 'https://github.com/gwapupward-hub/oar';

/** Expected-outcome table; `error` is matched against the CLI's stderr/stdout. */
export const CASES = [
  { name: 'register', as: 'payer', expect: 'ok' },
  { name: 'register again with the same nonce', as: 'payer', expect: /already in use|custom program error: 0x0|simulation failed/i },
  { name: 'update by a non-authority', as: 'ephemeral', expect: /Error Code: Unauthorized/ },
  { name: 'update by the authority', as: 'payer', expect: 'ok' },
  { name: 'accept with no pending authority', as: 'ephemeral', expect: /Error Code: NoPendingAuthority/ },
  { name: 'propose authority', as: 'payer', expect: 'ok' },
  { name: 'accept by a key that was not proposed', as: 'payer', expect: /Error Code: Unauthorized/ },
  { name: 'accept by the proposed key', as: 'ephemeral', expect: 'ok' },
  { name: 'update by the previous authority', as: 'payer', expect: /Error Code: Unauthorized/ },
  { name: 'set status deprecated', as: 'ephemeral', expect: 'ok' },
  { name: 'set status retired', as: 'ephemeral', expect: 'ok' },
  { name: 'update after retirement', as: 'ephemeral', expect: /Error Code: AppRetired/ },
];

export function judge(expect, res) {
  const text = `${res.stdout}\n${res.stderr}`;
  if (expect === 'ok') return { pass: res.ok, signature: text.match(/Signature (\w{64,88})/)?.[1] ?? null };
  return { pass: !res.ok && expect.test(text), error: text.match(/Error Code: \w+|already in use|simulation failed[^\n]*/i)?.[0] ?? text.split('\n').find(Boolean) };
}

async function computeUnits(rpc, sig) {
  for (let i = 0; i < 10; i++) {
    const tx = await rpc.getTransaction(toSignature(sig), { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
    if (tx) return { slot: Number(tx.slot), computeUnits: tx.meta?.computeUnitsConsumed == null ? null : Number(tx.meta.computeUnitsConsumed) };
    await new Promise(r => setTimeout(r, 1500));
  }
  return { slot: null, computeUnits: null };
}

async function main() {
  const { values: o } = parseArgs({ options: { rpc: { type: 'string', default: DEFAULT_RPC }, payer: { type: 'string' } } });
  if (!o.payer) fail('--payer is required');
  const id = declaredProgramId();
  const r = loadRecord();
  if (run('solana', ['genesis-hash', '-u', o.rpc]) !== DEVNET_GENESIS) fail(`RPC ${rpcHost(o.rpc)} is not devnet`);
  if (!r.deployment?.hashVerified || r.programId !== id) fail('release/devnet.json has no verified deployment of the declared program; run deploy.mjs first');
  if (!existsSync(CLI)) fail('Build the CLI first: npm run build');
  const cliId = run(process.execPath, ['--input-type=module', '-e', "import('@open-app-registry/sdk').then(m => console.log(m.OAR_PROGRAM_ID))"]);
  if (cliId !== id) fail(`Built SDK targets ${cliId}, source declares ${id}; rebuild with npm run build`);

  const payer = pubkeyOf(o.payer);
  const dir = mkdtempSync(join(tmpdir(), 'oar-smoke-'));
  const ephemeralPath = join(dir, 'ephemeral.json');
  const keys = { payer: o.payer, ephemeral: ephemeralPath };
  const results = [];
  let appId;
  try {
    run('solana-keygen', ['new', '--no-bip39-passphrase', '--silent', '--force', '-o', ephemeralPath]);
    const ephemeral = pubkeyOf(ephemeralPath);
    run('solana', ['transfer', ephemeral, '0.02', '--allow-unfunded-recipient', '-k', o.payer, '-u', o.rpc]);

    const nonce = String(Date.now());
    appId = run(process.execPath, [CLI, 'app-id', '--creator', payer, '--nonce', nonce]);
    const m1 = join(dir, 'm1.json');
    const m2 = join(dir, 'm2.json');
    run(process.execPath, [CLI, 'init', '--app', appId, '--cluster', 'devnet', '-o', m1]);
    writeFileSync(m2, JSON.stringify({ ...JSON.parse(readFileSync(m1, 'utf8')), name: 'OAR devnet smoke r1' }, null, 2));

    const net = ['-c', 'devnet', '-u', o.rpc];
    const argv = {
      'register': ['register', '-m', m1, '--uri', URI, '--nonce', nonce],
      'register again with the same nonce': ['register', '-m', m1, '--uri', URI, '--nonce', nonce],
      'update by a non-authority': ['update', '--app', appId, '-m', m2, '--uri', `${URI}#r1`],
      'update by the authority': ['update', '--app', appId, '-m', m2, '--uri', `${URI}#r1`],
      'accept with no pending authority': ['accept-authority', '--app', appId],
      'propose authority': ['propose-authority', '--app', appId, '--new', ephemeral],
      'accept by a key that was not proposed': ['accept-authority', '--app', appId],
      'accept by the proposed key': ['accept-authority', '--app', appId],
      'update by the previous authority': ['update', '--app', appId, '-m', m2, '--uri', `${URI}#r2`],
      'set status deprecated': ['set-status', '--app', appId, '--status', 'deprecated'],
      'set status retired': ['set-status', '--app', appId, '--status', 'retired', '--yes'],
      'update after retirement': ['update', '--app', appId, '-m', m2, '--uri', `${URI}#r3`],
    };
    const rpc = createSolanaRpc(o.rpc);
    for (const c of CASES) {
      const res = tryRun(process.execPath, [CLI, ...argv[c.name], ...net, '-k', keys[c.as]]);
      const verdict = judge(c.expect, res);
      const row = { case: c.name, signer: c.as, expected: c.expect === 'ok' ? 'success' : `error ${c.expect}`, ...verdict };
      if (verdict.signature) Object.assign(row, await computeUnits(rpc, verdict.signature));
      results.push(row);
      console.log(`  ${verdict.pass ? 'PASS' : 'FAIL'}  ${c.name}${row.computeUnits ? ` (${row.computeUnits} CU)` : ''}`);
      if (!verdict.pass) console.log(`        ${res.stderr || res.stdout}`);
    }

    const inspect = tryRun(process.execPath, [CLI, 'inspect', appId, '--json', '--no-live', ...net]);
    const app = inspect.ok ? JSON.parse(inspect.stdout) : null;
    const finalOk = app?.status === 'Retired' && app?.record?.authority === ephemeral && Number(app?.record?.revision) === 1;
    results.push({ case: 'final record state (Retired, new authority, revision 1)', pass: finalOk, observed: app ? { status: app.status, authority: app.record?.authority, revision: app.record?.revision } : inspect.stderr });
    console.log(`  ${finalOk ? 'PASS' : 'FAIL'}  final record state`);

    // Return the ephemeral key's remaining lamports; the key file is deleted below.
    tryRun('solana', ['transfer', payer, 'ALL', '-k', ephemeralPath, '--fee-payer', ephemeralPath, '-u', o.rpc]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const pass = results.length === CASES.length + 1 && results.every(x => x.pass);
  const at = new Date().toISOString();
  mkdirSync(join(root, 'release/evidence'), { recursive: true });
  const evidence = join(root, 'release/evidence', `devnet-smoke-${at.slice(0, 10)}-${id.slice(0, 8)}.json`);
  writeJson(evidence, { programId: id, cluster: 'solana:devnet', rpcHost: rpcHost(o.rpc), deploymentSlot: r.deployment.slot, appId, creator: payer, at, pass, results });
  r.smoke = { evidence: relative(root, evidence), pass, appId, at };
  saveRecord(r);
  report('Smoke', [['App ID', appId ?? 'not derived'], ['Cases', `${results.filter(x => x.pass).length}/${results.length} passed`], ['Evidence', relative(root, evidence)], ['Status', r.status]]);
  if (!pass) fail('Smoke suite failed; see the evidence file.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => fail(e.message));

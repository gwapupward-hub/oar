// Publish idl/oar_registry.json as the program's canonical Program Metadata IDL (seed "idl"), then read it back.
//
//   node scripts/devnet/publish-idl.mjs --upgrade-authority <path> --payer <path> --confirm <PROGRAM_ID> [--rpc <url>]
//
// Uses the program-metadata CLI pinned by package-lock.json, never @latest.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_RPC, DEVNET_GENESIS, canonicalJson, declaredProgramId, fail, pubkeyOf, report, root, rpcHost, run, sha256 } from './lib.mjs';
import { loadRecord, saveRecord } from './record.mjs';

const PM = join(root, 'node_modules', '.bin', 'program-metadata');
const IDL = join(root, 'idl', 'oar_registry.json');

export function idlMatches(local, fetched) {
  return canonicalJson(JSON.parse(local)) === canonicalJson(JSON.parse(fetched));
}

function main() {
  const { values: o } = parseArgs({
    options: { rpc: { type: 'string', default: DEFAULT_RPC }, 'upgrade-authority': { type: 'string' }, payer: { type: 'string' }, confirm: { type: 'string' } },
  });
  if (!o['upgrade-authority'] || !o.payer) fail('--upgrade-authority and --payer are required');
  const id = declaredProgramId();
  const r = loadRecord();
  const idlText = readFileSync(IDL, 'utf8');
  const idlHash = sha256(Buffer.from(idlText));

  if (run('solana', ['genesis-hash', '-u', o.rpc]) !== DEVNET_GENESIS) fail(`RPC ${rpcHost(o.rpc)} is not devnet`);
  if (!r.deployment?.hashVerified || r.programId !== id) fail('release/devnet.json has no verified deployment of the declared program; run deploy.mjs first');
  if (o.confirm !== id) fail(`Pass --confirm ${id} to publish the IDL on devnet.`);
  if (JSON.parse(idlText).address !== id) fail('IDL address differs from declare_id!');
  if (idlHash !== r.build?.idl_sha256) fail('idl/oar_registry.json differs from the IDL built with the deployed artifact');

  const authority = pubkeyOf(o['upgrade-authority']);
  const show = JSON.parse(run('solana', ['program', 'show', id, '-u', o.rpc, '--output', 'json']));
  if (show.authority !== authority) fail(`Canonical metadata must be signed by the upgrade authority ${show.authority}, not ${authority}`);

  const cliVersion = run(PM, ['--version']);
  console.log(`Writing Program Metadata "idl" for ${id} with program-metadata ${cliVersion}...`);
  const write = run(PM, ['write', 'idl', id, IDL, '--format', 'json', '-k', o['upgrade-authority'], '-p', o.payer, '--rpc', o.rpc]);
  console.log(write);

  const dir = mkdtempSync(join(tmpdir(), 'oar-idl-'));
  let fetched;
  try {
    run(PM, ['fetch', 'idl', id, '--rpc', o.rpc, '-o', join(dir, 'idl.json')]);
    fetched = readFileSync(join(dir, 'idl.json'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const verified = idlMatches(idlText, fetched);
  r.idl = { seed: 'idl', sha256: idlHash, verified, programMetadataCli: cliVersion, publishedBy: authority, publishedAt: new Date().toISOString() };
  saveRecord(r);
  report('IDL', [['Program', id], ['Seed', 'idl'], ['SHA-256', idlHash], ['Read back', verified ? 'matches' : 'DIFFERS']]);
  if (!verified) fail('Onchain IDL does not match idl/oar_registry.json');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    fail(e.message);
  }
}

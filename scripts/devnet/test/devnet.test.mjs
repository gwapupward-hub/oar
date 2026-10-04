import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVNET_GENESIS,
  EXPOSED_ID,
  UPGRADEABLE_LOADER,
  canonicalJson,
  executableHash,
  isPrerelease,
  missingFlags,
  parseSolanaVersion,
  rentExempt,
  rpcHost,
  sha256,
} from '../lib.mjs';
import { describeNonProgram, evaluate } from '../preflight.mjs';
import { deployArgs, parseDeployOutput, DEPLOY_FLAGS } from '../deploy.mjs';
import { CASES, judge } from '../smoke.mjs';
import { deriveStatus, gwapRecord } from '../record.mjs';
import { idlMatches } from '../publish-idl.mjs';

const ID = 'NewProgram1111111111111111111111111111111111';
const AUTH = 'Authority111111111111111111111111111111111111';
const PAYER = 'Payer11111111111111111111111111111111111111111';
const BUILDER = `quay.io/ottersec/anchor@sha256:${'a'.repeat(64)}`;
const SOL = 1_000_000_000n;

function facts(overrides = {}) {
  const base = {
    rpcHost: 'api.devnet.solana.com',
    declaredId: ID,
    cliVersion: '4.2.2',
    verifyVersion: '0.5.2',
    genesis: DEVNET_GENESIS,
    release: { builderImage: BUILDER },
    metadata: {
      repo_sha: 'c'.repeat(40),
      program_id: ID,
      builder_image: BUILDER,
      artifact_sha256: 'sha',
      executable_hash: 'exe',
      idl_sha256: 'idl',
      double_build_match: true,
    },
    artifact: { path: '/x/oar_registry.so', bytes: 175064, sha256: 'sha', executableHash: 'exe' },
    idlSha256: 'idl',
    git: { clean: true, head: 'd'.repeat(40), artifactCommitIsAncestor: true, programPathsChanged: false },
    sourceCheck: { ok: true, output: 'ok' },
    keys: { program: ID, authority: AUTH, payer: PAYER },
    onchain: { exists: false },
    payerLamports: 5n * SOL,
  };
  return { ...base, ...overrides };
}
const failuresOf = f => evaluate(f).failures.join('\n');

test('executable hash ignores trailing zero padding, as in a ProgramData dump', () => {
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 0, 2]);
  const padded = Buffer.concat([elf, Buffer.alloc(4096)]);
  assert.equal(executableHash(padded), executableHash(elf));
  assert.equal(executableHash(elf), sha256(elf));
  assert.notEqual(executableHash(elf), executableHash(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 0, 3])));
});

test('rent matches the runtime minimum for an empty account', () => {
  assert.equal(rentExempt(0), 890_880n);
});

test('version, prerelease, flag and host helpers', () => {
  assert.equal(parseSolanaVersion('solana-cli 4.2.2 (src:1; feat:2, client:Agave)'), '4.2.2');
  assert.ok(isPrerelease('4.3.0-rc.0'));
  assert.ok(!isPrerelease('4.2.2'));
  assert.deepEqual(missingFlags('  --program-id <ID>\n  -k, --keypair <PATH>\n', ['--program-id', '--keypair', '--use-rpc']), ['--use-rpc']);
  assert.equal(rpcHost('https://devnet.example.com/v1/SECRET?api-key=SECRET'), 'devnet.example.com');
});

test('a complete fresh-deploy fact set passes', () => {
  const v = evaluate(facts());
  assert.deepEqual(v.failures, []);
  assert.equal(v.mode, 'fresh');
  assert.ok(v.requiredLamports > 2n * SOL && v.requiredLamports < 3n * SOL, `estimate ${v.requiredLamports}`);
});

test('preflight refuses each unsafe condition', () => {
  const cases = [
    [{ genesis: 'MainnetGenesis' }, /not devnet/],
    [{ cliVersion: '4.3.0-rc.0' }, /prerelease/],
    [{ cliVersion: null }, /not found/],
    [{ declaredId: EXPOSED_ID, keys: { program: EXPOSED_ID, authority: AUTH, payer: PAYER } }, /exposed reference program ID/],
    [{ sourceCheck: { ok: false, output: 'Program identity drift' } }, /identity drift/],
    [{ release: { builderImage: 'quay.io/ottersec/anchor:v1.2.0' } }, /not digest-pinned/],
    [{ metadata: null }, /build-metadata.json missing/],
    [{ artifact: { ...facts().artifact, sha256: 'other' } }, /SHA-256 does not match/],
    [{ artifact: { ...facts().artifact, executableHash: 'other' } }, /executable hash does not match/],
    [{ idlSha256: 'other' }, /IDL built with the artifact/],
    [{ metadata: { ...facts().metadata, builder_image: `x@sha256:${'b'.repeat(64)}` } }, /differs from pinned/],
    [{ metadata: { ...facts().metadata, program_id: 'Other' } }, /built for Other/],
    [{ metadata: { ...facts().metadata, double_build_match: false } }, /second clean build/],
    [{ git: { ...facts().git, clean: false } }, /dirty/],
    [{ git: { ...facts().git, artifactCommitIsAncestor: false } }, /not in this checkout/],
    [{ git: { ...facts().git, programPathsChanged: true } }, /changed since artifact commit/],
    [{ keys: { program: ID, authority: PAYER, payer: PAYER } }, /must be different keys/],
    [{ keys: { program: ID, authority: ID, payer: PAYER } }, /upgrade authority must not be the program ID/],
    [{ keys: { program: null, authority: AUTH, payer: PAYER } }, /--program-keypair is required/],
    [{ keys: { program: 'Wrong', authority: AUTH, payer: PAYER } }, /Program keypair is Wrong/],
    [{ payerLamports: SOL }, /needs at least/],
    [{ payerLamports: null }, /payer balance/],
    [{ onchain: { error: 'rpc down' } }, /Could not read the program account/],
    [{ onchain: { prefunded: { lamports: 5n * SOL } } }, /already holds 5\.0000 SOL as a plain system account[\s\S]*solana transfer Payer1+ ALL --from <PROGRAM_KEYPAIR>/],
  ];
  for (const [patch, pattern] of cases) assert.match(failuresOf(facts(patch)), pattern, Object.keys(patch).join());
});

test('upgrade mode checks the onchain loader, authority and allocation', () => {
  const show = { owner: UPGRADEABLE_LOADER, authority: AUTH, dataLen: 175064, lastDeploySlot: 10 };
  const ok = evaluate(facts({ onchain: { exists: true, show }, keys: { program: null, authority: AUTH, payer: PAYER } }));
  assert.deepEqual(ok.failures, []);
  assert.equal(ok.mode, 'upgrade');
  assert.match(failuresOf(facts({ onchain: { exists: true, show: { ...show, authority: 'Someone' } } })), /Onchain upgrade authority is Someone/);
  assert.match(failuresOf(facts({ onchain: { exists: true, show: { ...show, authority: 'none' } } })), /immutable/);
  assert.match(failuresOf(facts({ onchain: { exists: true, show: { ...show, owner: 'BPFLoader2111111111111111111111111111111111' } } })), /upgradeable loader/);
  const grow = evaluate(facts({ onchain: { exists: true, show: { ...show, dataLen: 100000 } } }));
  assert.match(grow.warnings.join(), /must extend/);
  assert.ok(grow.requiredLamports > ok.requiredLamports);
});

test('deploy arguments use the keypair only for a fresh deploy and never --final', () => {
  const base = { soPath: 'a.so', programKeypair: '/k/program.json', programId: ID, authority: '/k/auth.json', payer: '/k/payer.json', rpc: 'https://r', computeUnitPrice: '10000' };
  const fresh = deployArgs({ ...base, mode: 'fresh' });
  const upgrade = deployArgs({ ...base, mode: 'upgrade' });
  assert.equal(fresh[fresh.indexOf('--program-id') + 1], '/k/program.json');
  assert.equal(upgrade[upgrade.indexOf('--program-id') + 1], ID);
  for (const a of [fresh, upgrade]) {
    assert.ok(!a.includes('--final'));
    assert.equal(a[a.indexOf('--upgrade-authority') + 1], '/k/auth.json');
    for (const flag of DEPLOY_FLAGS) assert.ok(a.includes(flag), flag);
  }
  assert.deepEqual(parseDeployOutput('progress\n{"programId":"X","signature":"S"}\n'), { programId: 'X', signature: 'S' });
  assert.deepEqual(parseDeployOutput('no json'), {});
});

test('smoke judging distinguishes expected successes from expected errors', () => {
  const sig = '5'.repeat(88);
  assert.deepEqual(judge('ok', { ok: true, stdout: `Signature ${sig}`, stderr: '' }), { pass: true, signature: sig });
  assert.equal(judge('ok', { ok: false, stdout: '', stderr: 'boom' }).pass, false);
  const unauthorized = CASES.find(c => c.name === 'update by a non-authority').expect;
  const err = 'Error: AnchorError caused by account: app_record. Error Code: Unauthorized. Error Number: 6005.';
  assert.deepEqual(judge(unauthorized, { ok: false, stdout: '', stderr: err }), { pass: true, error: 'Error Code: Unauthorized' });
  assert.equal(judge(unauthorized, { ok: true, stdout: `Signature ${sig}`, stderr: '' }).pass, false);
  assert.equal(judge(unauthorized, { ok: false, stdout: '', stderr: 'Error Code: AppRetired' }).pass, false);
  assert.ok(CASES.filter(c => c.expect !== 'ok').length >= 6);
});

test('release status needs hash, IDL and smoke evidence', () => {
  const r = { cluster: 'solana:devnet', programId: ID, build: { repo_sha: 'c'.repeat(40), artifact_sha256: 'sha' } };
  assert.equal(deriveStatus(r), 'NOT_READY');
  r.deployment = { hashVerified: true, programDataAddress: 'PD', slot: 5, onchainExecutableHash: 'exe' };
  assert.equal(deriveStatus(r), 'PILOT');
  r.idl = { verified: true, sha256: 'idl' };
  r.smoke = { pass: true, evidence: 'release/evidence/x.json' };
  assert.equal(deriveStatus(r), 'DEVNET_VERIFIED');
  const g = gwapRecord(r);
  for (const k of ['release_id', 'system', 'repo', 'repo_sha', 'environment', 'status']) assert.ok(g[k], k);
  assert.deepEqual(g.blockers, []);
  assert.equal(g.deployed_hash, 'exe');
});

test('IDL comparison ignores key order and whitespace only', () => {
  assert.ok(idlMatches('{"a":1,"b":[1,2]}', '{ "b": [1, 2], "a": 1 }'));
  assert.ok(!idlMatches('{"a":1,"b":[1,2]}', '{"a":1,"b":[2,1]}'));
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('a funded system account at the program address is reported as pre-funded, anything else as an error', () => {
  const show = { ok: false, stdout: '', stderr: 'Error: X is not an SBF program' };
  const system = { ok: true, stderr: '', stdout: '{"pubkey":"X","account":{"lamports":5000000000,"data":["","base64"],"owner":"11111111111111111111111111111111","executable":false,"rentEpoch":18446744073709551615,"space":0}}' };
  assert.deepEqual(describeNonProgram(system, show), { prefunded: { lamports: 5_000_000_000n } });
  const token = { ...system, stdout: system.stdout.replace('11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').replace('"space":0', '"space":165') };
  assert.match(describeNonProgram(token, show).error, /owned by Tokenkeg/);
  assert.equal(describeNonProgram({ ok: false, stdout: '', stderr: 'rpc down' }, show).error, show.stderr);
  assert.match(evaluate(facts({ onchain: { prefunded: { lamports: 1n } } })).failures.join(), /plain system account/);
  assert.equal(evaluate(facts({ onchain: { prefunded: { lamports: 1n } } })).mode, null);
});

// SAS compatibility rehearsal on devnet: a TEST issuer issues correct and deliberately wrong OAR evidence,
// and the SDK must accept exactly the correct evidence, only from a trusted credential, only while it is live.
//
//   node scripts/devnet/sas-rehearsal.mjs --payer <path> --issuer <path> --confirm devnet [--rpc <url>]
//
// The issuer is a dedicated devnet key: SAS credential authority and its only authorized signer.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_RPC, DEVNET_GENESIS, declaredProgramId, fail, report, root, rpcHost, run, tryRun, writeJson } from './lib.mjs';
import { loadRecord, saveRecord } from './record.mjs';

export const CREDENTIAL_NAME = 'oar-devnet-rehearsal';
export const CLUSTER = 'solana:devnet';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const REPO = 'https://github.com/gwapupward-hub/oar';
export const LINK_SCHEMAS = ['oar-domain', 'oar-repo', 'oar-program'];
const CLI = join(root, 'packages/cli/dist/index.js');

/** The claims the throwaway app makes; none can be proven live, so attestations decide them. */
export const CLAIMS = {
  domain: { schema: 'oar-domain', subject: 'example.com' },
  repo: { schema: 'oar-repo', subject: REPO },
  program: { schema: 'oar-program', subject: MEMO_PROGRAM, programCluster: CLUSTER },
};

export function buildManifest(appId) {
  return {
    oar: '0.1',
    app_id: appId,
    cluster: CLUSTER,
    name: 'OAR SAS rehearsal',
    summary: 'Throwaway devnet app used to rehearse SAS evidence handling.',
    categories: ['developer-tools'],
    domains: [CLAIMS.domain.subject],
    repositories: [{ url: REPO, role: 'program' }],
    programs: [{ address: MEMO_PROGRAM, cluster: CLUSTER, name: 'Memo (no backlink)' }],
  };
}

/** Version 1 is the pre-hardening shape: the same fields without cluster binding. The SDK must ignore it. */
export function schemaDef(OAR_SCHEMAS, name, version) {
  const v2 = OAR_SCHEMAS[name];
  if (version === 2) return { layout: [...v2.layout], fields: [...v2.fields] };
  const keep = v2.fields.map((f, i) => [f, v2.layout[i]]).filter(([f]) => f !== 'app_cluster' && f !== 'program_cluster');
  return { layout: keep.map(([, l]) => l), fields: keep.map(([f]) => f) };
}

/** Field-name bytes in the form sas-lib's serializer expects (u32 length prefix per name). */
export const fieldBytes = fields => Uint8Array.from(fields.flatMap(f => [f.length, 0, 0, 0, ...new TextEncoder().encode(f)]));

export function payload({ kind, appIdBytes, appCluster = CLUSTER, subject, subjectBytes, method = 0, programCluster = CLUSTER, checkedAt }) {
  const base = { app_id: Array.from(appIdBytes), app_cluster: appCluster, checked_at: checkedAt };
  if (kind === 'domain') return { ...base, host: subject, method };
  if (kind === 'repo') return { ...base, url: subject };
  return { ...base, program: Array.from(subjectBytes), program_cluster: programCluster, method };
}

export function encodeData(sas, def, data) {
  return sas.serializeAttestationData({ layout: Uint8Array.from(def.layout), fieldNames: fieldBytes(def.fields) }, data);
}

/** Claim states from the SDK exactly as a wallet computes them; live HTTP/DNS is off so evidence decides. */
export async function resolveStates(s, rpc, appId, manifest, uri, trustedIssuers) {
  const app = await s.resolveApp(rpc, appId, {
    cluster: CLUSTER,
    live: false,
    trustedIssuers,
    fetch: async url => (url === uri ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('', { status: 404 })),
  });
  if (!app || !app.manifest.ok) return { error: app ? `manifest ${app.manifest.reason}` : 'no AppRecord' };
  return { domain: app.domains[0]?.state, repo: app.repositories[0]?.state, program: app.programs[0]?.state };
}

export async function claimStatus(s, rpc, { credential, appId, kind, programCluster }) {
  const c = CLAIMS[kind];
  const res = await s.fetchClaimAttestation(rpc, {
    credential, schema: c.schema, appId, subject: c.subject, appCluster: CLUSTER,
    ...(kind === 'program' ? { programCluster: programCluster ?? CLUSTER } : {}),
  });
  return res.status;
}

/** Deep-equal on plain values, for expected-vs-observed checks. */
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const { values: o } = parseArgs({
    options: { rpc: { type: 'string', default: DEFAULT_RPC }, payer: { type: 'string' }, issuer: { type: 'string' }, confirm: { type: 'string' } },
  });
  if (!o.payer || !o.issuer) fail('--payer and --issuer are required');
  if (o.confirm !== 'devnet') fail('Pass --confirm devnet to create SAS accounts and a throwaway App ID on devnet.');
  if (!existsSync(CLI)) fail('Build first: npm run build');
  const s = await import('@open-app-registry/sdk');
  const sas = await import('sas-lib');
  const kit = await import('@solana/kit');
  const { loadKeypair, sendAndConfirm } = await import(pathToFileURL(join(root, 'packages/cli/dist/tx.js')).href);

  const r = loadRecord();
  const programId = declaredProgramId();
  if (!r.deployment?.hashVerified || r.programId !== programId) fail('release/devnet.json has no verified deployment of the declared program');
  if (run('solana', ['genesis-hash', '-u', o.rpc]) !== DEVNET_GENESIS) fail(`RPC ${rpcHost(o.rpc)} is not devnet`);
  const rpc = kit.createSolanaRpc(o.rpc);
  const sasAccount = await kit.fetchEncodedAccount(rpc, s.SAS_PROGRAM_ID);
  if (!sasAccount.exists || !sasAccount.executable) fail(`SAS program ${s.SAS_PROGRAM_ID} is not deployed on this cluster`);
  const payer = await loadKeypair(o.payer);
  const issuer = await loadKeypair(o.issuer);
  if (payer.address === issuer.address) fail('Use a dedicated issuer key, not the fee payer');

  const log = [];
  const results = [];
  const send = async (label, ixs) => {
    const sig = await sendAndConfirm(rpc, payer, ixs);
    // The SDK reads finalized state only.
    for (let i = 0; i < 40; i++) {
      const { value } = await rpc.getSignatureStatuses([sig]).send();
      if (value[0]?.confirmationStatus === 'finalized') break;
      await new Promise(res => setTimeout(res, 1500));
    }
    log.push({ label, signature: sig });
    console.log(`  tx    ${label}  ${sig.slice(0, 16)}…`);
    return sig;
  };
  const expect = (name, observed, expected) => {
    const pass = same(observed, expected);
    results.push({ case: name, pass, expected, observed });
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `: expected ${JSON.stringify(expected)}, got ${JSON.stringify(observed)}`}`);
  };

  // --- Provision: TEST credential and schema v1 -> v2 (idempotent across re-runs) ---
  const [credential] = await sas.deriveCredentialPda({ authority: issuer.address, name: CREDENTIAL_NAME });
  if (!(await kit.fetchEncodedAccount(rpc, credential)).exists) {
    await send('create credential', [sas.getCreateCredentialInstruction({ payer, credential, authority: issuer, name: CREDENTIAL_NAME, signers: [issuer.address] })]);
  }
  const schemas = {};
  for (const name of LINK_SCHEMAS) {
    const [v1] = await sas.deriveSchemaPda({ credential, name, version: 1 });
    const [v2] = await sas.deriveSchemaPda({ credential, name, version: 2 });
    const d1 = schemaDef(s.OAR_SCHEMAS, name, 1);
    const d2 = schemaDef(s.OAR_SCHEMAS, name, 2);
    if (!(await kit.fetchEncodedAccount(rpc, v1)).exists) {
      await send(`create ${name} v1`, [sas.getCreateSchemaInstruction({ payer, authority: issuer, credential, schema: v1, name, description: 'OAR rehearsal (legacy v1 shape)', layout: Uint8Array.from(d1.layout), fieldNames: d1.fields })]);
    }
    if (!(await kit.fetchEncodedAccount(rpc, v2)).exists) {
      await send(`create ${name} v2`, [sas.getChangeSchemaVersionInstruction({ payer, authority: issuer, credential, existingSchema: v1, newSchema: v2, layout: Uint8Array.from(d2.layout), fieldNames: d2.fields })]);
    }
    const acct = await kit.fetchEncodedAccount(rpc, v2, { commitment: 'finalized' });
    if (acct.exists && !s.validateClaimSchema(Uint8Array.from(acct.data), credential, name)) {
      // A paused schema from an interrupted run is the only acceptable difference; anything else is a real incompatibility.
      await send(`unpause ${name} v2`, [sas.getChangeSchemaStatusInstruction({ authority: issuer, credential, schema: v2, isPaused: false })]);
    }
    const ok = s.validateClaimSchema(Uint8Array.from((await kit.fetchEncodedAccount(rpc, v2, { commitment: 'finalized' })).data), credential, name);
    expect(`${name} v2 schema matches the SDK layout, field names and version`, ok, true);
    schemas[name] = { v1, v2, d1, d2 };
  }

  // --- Throwaway app whose manifest the SDK receives through an injected fetch (hash still checked onchain) ---
  const nonce = BigInt(Date.now());
  const appId = await s.findAppId({ creator: payer.address, nonce });
  const manifest = buildManifest(appId);
  const uri = `https://example.com/oar-sas-rehearsal/${nonce}.json`;
  const tmp = mkdtempSync(join(tmpdir(), 'oar-sas-'));
  const manifestFile = join(tmp, 'manifest.json');
  writeJson(manifestFile, manifest);
  const reg = tryRun(process.execPath, [CLI, 'register', '-m', manifestFile, '--uri', uri, '--nonce', String(nonce), '-c', 'devnet', '-u', o.rpc, '-k', o.payer]);
  rmSync(tmp, { recursive: true, force: true });
  if (!reg.ok) fail(`register failed: ${reg.stderr || reg.stdout}`);
  log.push({ label: 'register throwaway app', signature: reg.stdout.match(/Signature (\w+)/)?.[1] ?? null });
  for (let i = 0; i < 20 && (await resolveStates(s, rpc, appId, manifest, uri, [])).error; i++) await new Promise(res => setTimeout(res, 1500));

  const enc = kit.getAddressEncoder();
  const appIdBytes = enc.encode(appId);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const checkedAt = now - 120n;
  const goodExpiry = now + 7n * 86400n;
  const live = [];
  const attest = async (label, kind, { version = 2, data = {}, expiry = goodExpiry, nonceCluster } = {}) => {
    const c = CLAIMS[kind];
    const sch = schemas[c.schema];
    const def = version === 2 ? sch.d2 : sch.d1;
    const programCluster = kind === 'program' ? (nonceCluster ?? CLUSTER) : undefined;
    const attNonce = s.deriveAttestationNonce(c.schema, appId, c.subject, { appCluster: CLUSTER, programCluster });
    const schemaPda = version === 2 ? sch.v2 : sch.v1;
    const [attestation] = await sas.deriveAttestationPda({ credential, schema: schemaPda, nonce: attNonce });
    const p = { ...payload({ kind, appIdBytes, subject: c.subject, subjectBytes: kind === 'program' ? enc.encode(c.subject) : undefined, programCluster, checkedAt }), ...data };
    const fields = Object.fromEntries(def.fields.map(f => [f, p[f]]));
    await send(label, [sas.getCreateAttestationInstruction({ payer, authority: issuer, credential, schema: schemaPda, attestation, nonce: attNonce, data: encodeData(sas, def, fields), expiry })]);
    live.push(attestation);
    return attestation;
  };
  const close = async (label, attestation) => {
    await send(label, [sas.getCloseAttestationInstruction({ payer, authority: issuer, credential, attestation })]);
    live.splice(live.indexOf(attestation), 1);
  };
  const status = (kind, programCluster) => claimStatus(s, rpc, { credential, appId, kind, programCluster });
  const states = trusted => resolveStates(s, rpc, appId, manifest, uri, trusted);
  const ALL = v => ({ domain: v, repo: v, program: v });

  try {
    expect('no evidence: every claim unverified', await states([credential]), ALL('unverified'));

    let a = await attest('domain evidence naming another host', 'domain', { data: { host: 'attacker.example' } });
    expect('wrong subject at the correct address -> mismatch', await status('domain'), 'mismatch');
    expect('mismatched evidence is not shown', (await states([credential])).domain, 'unverified');
    await close('close mismatched domain evidence', a);

    a = await attest('repo evidence bound to mainnet', 'repo', { data: { app_cluster: 'solana:mainnet' } });
    expect('wrong app cluster -> mismatch', await status('repo'), 'mismatch');
    await close('close cross-cluster repo evidence', a);

    a = await attest('domain evidence with method 2', 'domain', { data: { method: 2 } });
    expect('unsupported domain method -> invalid', await status('domain'), 'invalid');
    await close('close method-2 domain evidence', a);

    a = await attest('program evidence with method 1', 'program', { data: { method: 1 } });
    expect('non-canonical program method -> invalid', await status('program'), 'invalid');
    await close('close method-1 program evidence', a);

    a = await attest('repo evidence expiring after the 30-day TTL', 'repo', { expiry: checkedAt + 30n * 86400n + 3600n });
    expect('expiry beyond TTL -> invalid', await status('repo'), 'invalid');
    await close('close over-TTL repo evidence', a);

    let zeroExpiry;
    try {
      a = await attest('repo evidence with no expiry', 'repo', { expiry: 0n });
      zeroExpiry = await status('repo');
      await close('close no-expiry repo evidence', a);
    } catch (e) {
      zeroExpiry = 'rejected by SAS';
    }
    expect('zero expiry is never accepted', ['invalid', 'rejected by SAS'].includes(zeroExpiry), true);

    await attest('legacy v1 domain evidence', 'domain', { version: 1 });
    expect('v1-schema evidence is not looked up', await status('domain'), 'none');

    await attest('program evidence for the mainnet program cluster', 'program', { nonceCluster: 'solana:mainnet', data: { program_cluster: 'solana:mainnet' } });
    expect('mainnet program evidence does not count on devnet', await status('program'), 'none');
    expect('mainnet program evidence is valid in its own context', await status('program', 'solana:mainnet'), 'valid');

    await attest('valid domain evidence (DNS method)', 'domain', { data: { method: 1 } });
    const repoAtt = await attest('valid repo evidence', 'repo');
    await attest('valid program evidence', 'program');
    expect('valid evidence from an untrusted issuer is ignored (default empty trust list)', await states([]), ALL('unverified'));
    expect('valid evidence from the trusted credential -> attested', await states([credential]), ALL('attested'));

    await send('pause oar-domain v2', [sas.getChangeSchemaStatusInstruction({ authority: issuer, credential, schema: schemas['oar-domain'].v2, isPaused: true })]);
    expect('paused schema fails closed', await status('domain'), 'invalid');
    expect('paused schema only affects its own claims', await states([credential]), { domain: 'unverified', repo: 'attested', program: 'attested' });
    await send('unpause oar-domain v2', [sas.getChangeSchemaStatusInstruction({ authority: issuer, credential, schema: schemas['oar-domain'].v2, isPaused: false })]);
    expect('unpaused schema is accepted again', await status('domain'), 'valid');

    await close('revoke repo evidence', repoAtt);
    expect('revoked evidence -> none', await status('repo'), 'none');
    expect('revoked claim drops back to unverified', (await states([credential])).repo, 'unverified');
  } catch (e) {
    // Keep the evidence of an aborted run; the first error is the finding.
    results.push({ case: 'rehearsal aborted', pass: false, observed: e.message });
    console.log(`  FAIL  rehearsal aborted: ${e.message}`);
  } finally {
    for (const att of [...live]) await close('cleanup: close evidence', att).catch(e => console.log(`  WARN  could not close ${att}: ${e.message}`));
    const retire = tryRun(process.execPath, [CLI, 'set-status', '--app', appId, '--status', 'retired', '--yes', '-c', 'devnet', '-u', o.rpc, '-k', o.payer]);
    log.push({ label: 'retire throwaway app', signature: retire.stdout.match(/Signature (\w+)/)?.[1] ?? null, ok: retire.ok });
  }

  const pass = results.length > 0 && results.every(x => x.pass);
  const at = new Date().toISOString();
  mkdirSync(join(root, 'release/evidence'), { recursive: true });
  const evidence = join(root, 'release/evidence', `devnet-sas-rehearsal-${at.slice(0, 10)}-${credential.slice(0, 8)}.json`);
  writeJson(evidence, {
    cluster: CLUSTER, rpcHost: rpcHost(o.rpc), at, pass, programId, sasProgram: s.SAS_PROGRAM_ID,
    sasLib: JSON.parse(readFileSync(join(root, 'node_modules/sas-lib/package.json'), 'utf8')).version,
    issuer: issuer.address, credential, credentialName: CREDENTIAL_NAME,
    schemas: Object.fromEntries(Object.entries(schemas).map(([k, v]) => [k, { v1: v.v1, v2: v.v2 }])),
    testApp: { appId, nonce: String(nonce), uri, manifestSha256: s.hashManifestHex(manifest) },
    results, transactions: log, openAttestations: live,
  });
  r.sas = { pass, credential, issuer: issuer.address, evidence: relative(root, evidence), at };
  saveRecord(r);
  report('SAS rehearsal', [
    ['Credential', `${credential} (${CREDENTIAL_NAME})`],
    ['Cases', `${results.filter(x => x.pass).length}/${results.length} passed`],
    ['Open evidence left', String(live.length)],
    ['Evidence', relative(root, evidence)],
  ]);
  if (!pass) fail('SAS rehearsal failed; see the evidence file.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => fail(e.message));

// Offline checks for the self-registration and SAS rehearsal scripts. Accounts are built with the real
// sas-lib and SDK encoders and served by a fake RPC, so the SDK judges them exactly as it will on devnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sas from 'sas-lib';
import { getAddressEncoder, generateKeyPairSigner } from '@solana/kit';
import * as s from '@open-app-registry/sdk';
import { buildManifest as oarManifest, manifestUri, NONCE } from '../oar-app.mjs';
import { CLAIMS, CLUSTER, MEMO_PROGRAM, buildManifest, claimStatus, encodeData, fieldBytes, payload, resolveStates, schemaDef } from '../sas-rehearsal.mjs';

const enc = getAddressEncoder();
const b64 = bytes => Buffer.from(bytes).toString('base64');

function fakeRpc(accounts) {
  return {
    getAccountInfo: address => ({
      send: async () => {
        const a = accounts.get(address);
        return { context: { slot: 1n }, value: a ? { data: [b64(a.data), 'base64'], executable: false, lamports: 1_000_000n, owner: a.owner, space: BigInt(a.data.length), rentEpoch: 0n } : null };
      },
    }),
  };
}

async function world() {
  const creator = (await generateKeyPairSigner()).address;
  const issuer = (await generateKeyPairSigner()).address;
  const [credential] = await sas.deriveCredentialPda({ authority: issuer, name: 'oar-devnet-rehearsal' });
  const nonce = 7n;
  const appId = await s.findAppId({ creator, nonce });
  const [, bump] = await s.findAppRecordPda({ creator, nonce });
  const manifest = buildManifest(appId);
  const uri = 'https://example.com/oar-sas-rehearsal/7.json';
  const accounts = new Map();
  const record = s.getAppRecordEncoder().encode({
    layoutVersion: 1, bump, status: 0, creator, nonce, authority: creator,
    pendingAuthority: '11111111111111111111111111111111', manifestHash: s.hashManifest(manifest),
    revision: 0, createdSlot: 1n, updatedSlot: 1n, manifestUri: uri,
  });
  const padded = new Uint8Array(s.APP_RECORD_SIZE);
  padded.set(record);
  accounts.set(appId, { owner: s.OAR_PROGRAM_ID, data: padded });
  // SAS account discriminators (upstream): Credential 0, Schema 1, Attestation 2.
  accounts.set(credential, { owner: s.SAS_PROGRAM_ID, data: Uint8Array.from(sas.getCredentialEncoder().encode({
    discriminator: 0, authority: issuer, name: new TextEncoder().encode('oar-devnet-rehearsal'), authorizedSigners: [issuer],
  })) });

  const schemas = {};
  const putSchema = async (name, version, paused = false) => {
    const def = schemaDef(s.OAR_SCHEMAS, name, version);
    const [pda] = await sas.deriveSchemaPda({ credential, name, version });
    accounts.set(pda, { owner: s.SAS_PROGRAM_ID, data: Uint8Array.from(sas.getSchemaEncoder().encode({
      discriminator: 1, credential, name: new TextEncoder().encode(name), description: new Uint8Array(),
      layout: Uint8Array.from(def.layout), fieldNames: fieldBytes(def.fields), isPaused: paused, version,
    })) });
    return pda;
  };
  for (const name of ['oar-domain', 'oar-repo', 'oar-program']) schemas[name] = { v1: await putSchema(name, 1), v2: await putSchema(name, 2), put: putSchema };

  const now = BigInt(Math.floor(Date.now() / 1000));
  const checkedAt = now - 120n;
  const attest = async (kind, { version = 2, data = {}, expiry = now + 86400n, nonceCluster } = {}) => {
    const c = CLAIMS[kind];
    const def = schemaDef(s.OAR_SCHEMAS, c.schema, version);
    const programCluster = kind === 'program' ? (nonceCluster ?? CLUSTER) : undefined;
    const attNonce = s.deriveAttestationNonce(c.schema, appId, c.subject, { appCluster: CLUSTER, programCluster });
    const schema = version === 2 ? schemas[c.schema].v2 : schemas[c.schema].v1;
    const [address] = await sas.deriveAttestationPda({ credential, schema, nonce: attNonce });
    const p = { ...payload({ kind, appIdBytes: enc.encode(appId), subject: c.subject, subjectBytes: kind === 'program' ? enc.encode(c.subject) : undefined, programCluster, checkedAt }), ...data };
    const fields = Object.fromEntries(def.fields.map(f => [f, p[f]]));
    accounts.set(address, { owner: s.SAS_PROGRAM_ID, data: Uint8Array.from(sas.getAttestationEncoder().encode({
      discriminator: 2, nonce: attNonce, credential, schema, data: encodeData(sas, def, fields), signer: issuer,
      expiry, tokenAccount: '11111111111111111111111111111111',
    })) });
    return address;
  };
  const rpc = fakeRpc(accounts);
  return {
    accounts, rpc, credential, appId, checkedAt, schemas, attest,
    status: (kind, programCluster) => claimStatus(s, rpc, { credential, appId, kind, programCluster }),
    states: trusted => resolveStates(s, rpc, appId, manifest, uri, trusted),
  };
}
const ALL = v => ({ domain: v, repo: v, program: v });

test('self-registration manifest and repo proof are valid and bound to the derived App ID', async () => {
  const appId = await s.findAppId({ creator: '91N96ZPGHcFWe2jEZie9rUVqyHF5BWMV7mYnHMurhWB7', nonce: NONCE });
  assert.equal(appId, 'Bu1JCyxiVDdDGjtNLLkKhq6KZv6E4LcUgqNkS5t5Nf2K');
  const m = oarManifest({ appId, programId: 'oariw8YXcYJh9sa9VcmBU3ZCdo2WVGMYPsLjEuUxfrC' });
  assert.deepEqual(s.validateManifest(m), { valid: true, errors: [] });
  assert.ok(s.validateProofFile(s.buildProofFile([{ appId, cluster: CLUSTER }])).valid);
  assert.equal(s.repoProofUrl(m.repositories[0].url), 'https://raw.githubusercontent.com/gwapupward-hub/oar/HEAD/oar.json');
  assert.match(manifestUri('a'.repeat(40)), /^https:\/\/raw\.githubusercontent\.com\/gwapupward-hub\/oar\/a{40}\/release\/devnet\/oar\.manifest\.json$/);
  assert.throws(() => manifestUri('main'), /full commit SHA/);
});

test('rehearsal schemas: v2 matches the SDK exactly, v1 drops cluster binding and is rejected', async () => {
  const w = await world();
  for (const name of ['oar-domain', 'oar-repo', 'oar-program']) {
    const v2 = w.accounts.get(w.schemas[name].v2).data;
    const v1 = w.accounts.get(w.schemas[name].v1).data;
    assert.ok(s.validateClaimSchema(v2, w.credential, name), name);
    assert.ok(!s.validateClaimSchema(v1, w.credential, name), `${name} v1`);
    assert.ok(!schemaDef(s.OAR_SCHEMAS, name, 1).fields.some(f => f.endsWith('_cluster')));
  }
  assert.ok(buildManifest('11111111111111111111111111111111').programs[0].address === MEMO_PROGRAM);
});

test('rehearsal expectations hold against SDK judgement of sas-lib encoded accounts', async () => {
  const w = await world();
  assert.deepEqual(await w.states([w.credential]), ALL('unverified'));

  let a = await w.attest('domain', { data: { host: 'attacker.example' } });
  assert.equal(await w.status('domain'), 'mismatch');
  assert.equal((await w.states([w.credential])).domain, 'unverified');
  w.accounts.delete(a);

  a = await w.attest('repo', { data: { app_cluster: 'solana:mainnet' } });
  assert.equal(await w.status('repo'), 'mismatch');
  w.accounts.delete(a);

  a = await w.attest('domain', { data: { method: 2 } });
  assert.equal(await w.status('domain'), 'invalid');
  w.accounts.delete(a);

  a = await w.attest('program', { data: { method: 1 } });
  assert.equal(await w.status('program'), 'invalid');
  w.accounts.delete(a);

  a = await w.attest('repo', { expiry: w.checkedAt + 30n * 86400n + 3600n });
  assert.equal(await w.status('repo'), 'invalid');
  w.accounts.delete(a);
  a = await w.attest('repo', { expiry: 0n });
  assert.equal(await w.status('repo'), 'invalid');
  w.accounts.delete(a);

  await w.attest('domain', { version: 1 });
  assert.equal(await w.status('domain'), 'none');

  await w.attest('program', { nonceCluster: 'solana:mainnet', data: { program_cluster: 'solana:mainnet' } });
  assert.equal(await w.status('program'), 'none');
  assert.equal(await w.status('program', 'solana:mainnet'), 'valid');

  await w.attest('domain', { data: { method: 1 } });
  const repo = await w.attest('repo');
  await w.attest('program');
  assert.deepEqual(await w.states([]), ALL('unverified'));
  assert.deepEqual(await w.states([w.credential]), ALL('attested'));

  await w.schemas['oar-domain'].put('oar-domain', 2, true);
  assert.equal(await w.status('domain'), 'invalid');
  assert.deepEqual(await w.states([w.credential]), { domain: 'unverified', repo: 'attested', program: 'attested' });
  await w.schemas['oar-domain'].put('oar-domain', 2, false);
  assert.equal(await w.status('domain'), 'valid');

  w.accounts.delete(repo);
  assert.equal(await w.status('repo'), 'none');
  assert.equal((await w.states([w.credential])).repo, 'unverified');
});

test('every SAS instruction the rehearsal sends signs offline with kit 8 signers', async () => {
  const kit = await import('@solana/kit');
  const payer = await generateKeyPairSigner();
  const issuer = await generateKeyPairSigner();
  const [credential] = await sas.deriveCredentialPda({ authority: issuer.address, name: 'oar-devnet-rehearsal' });
  const [v1] = await sas.deriveSchemaPda({ credential, name: 'oar-repo', version: 1 });
  const [v2] = await sas.deriveSchemaPda({ credential, name: 'oar-repo', version: 2 });
  const d1 = schemaDef(s.OAR_SCHEMAS, 'oar-repo', 1);
  const d2 = schemaDef(s.OAR_SCHEMAS, 'oar-repo', 2);
  const attNonce = s.deriveAttestationNonce('oar-repo', credential, 'https://github.com/gwapupward-hub/oar', { appCluster: CLUSTER });
  const [attestation] = await sas.deriveAttestationPda({ credential, schema: v2, nonce: attNonce });
  const ixs = [
    sas.getCreateCredentialInstruction({ payer, credential, authority: issuer, name: 'oar-devnet-rehearsal', signers: [issuer.address] }),
    sas.getCreateSchemaInstruction({ payer, authority: issuer, credential, schema: v1, name: 'oar-repo', description: 'x', layout: Uint8Array.from(d1.layout), fieldNames: d1.fields }),
    sas.getChangeSchemaVersionInstruction({ payer, authority: issuer, credential, existingSchema: v1, newSchema: v2, layout: Uint8Array.from(d2.layout), fieldNames: d2.fields }),
    sas.getCreateAttestationInstruction({ payer, authority: issuer, credential, schema: v2, attestation, nonce: attNonce, data: new Uint8Array(8), expiry: 1n }),
    sas.getChangeSchemaStatusInstruction({ authority: issuer, credential, schema: v2, isPaused: true }),
    sas.getCloseAttestationInstruction({ payer, authority: issuer, credential, attestation }),
  ];
  for (const ix of ixs) {
    const msg = kit.pipe(
      kit.createTransactionMessage({ version: 0 }),
      m => kit.setTransactionMessageFeePayerSigner(payer, m),
      m => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 0n }, m),
      m => kit.appendTransactionMessageInstructions([ix], m),
    );
    const tx = await kit.signTransactionMessageWithSigners(msg);
    assert.ok(Object.keys(tx.signatures).includes(issuer.address), 'issuer signs');
    assert.ok(Object.values(tx.signatures).every(Boolean), 'all signatures present');
    assert.equal(ix.programAddress, s.SAS_PROGRAM_ID);
  }
});

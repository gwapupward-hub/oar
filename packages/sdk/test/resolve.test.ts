import { putClaim } from './claim-fixtures.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner, getAddressEncoder, getI64Encoder, getU32Encoder, type Address } from '@solana/kit';
import {
  Compression,
  DataSource,
  Encoding,
  Format,
  findCanonicalPda,
  getMetadataEncoder,
  packDirectData,
} from '@solana-program/program-metadata';
import {
  PROGRAM_METADATA_PROGRAM_ID,
  SAS_ATTESTATION_DISCRIMINATOR,
  SAS_PROGRAM_ID,
  buildProgramLink,
  buildProofFile,
  checkDomain,
  deriveAttestationNonce,
  deriveAttestationPda,
  deriveSchemaPda,
  findAppId,
  getRegisterInstructionAsync,
  getSetStatusInstruction,
  hashManifest,
  repoProofUrl,
  resolveApp,
  resolveProgram,
  type OarManifest,
} from '../src/index.js';
import { createSvm, fundedSigner, send, setRawAccount, stubFetch, svmRpc } from './helpers.js';

const CLUSTER = 'solana:devnet' as const;
const MANIFEST_URL = 'https://cdn.gwapspot.fun/oar/manifest.json';
const REPO = 'https://github.com/gwapupward-hub/oar';

function backlinkAccount(program: Address, content: string, opts: { canonical?: boolean; dataSource?: DataSource } = {}) {
  const packed = packDirectData({ content, compression: Compression.Zlib, encoding: Encoding.Utf8 });
  return Uint8Array.from(
    getMetadataEncoder().encode({
      program,
      authority: null,
      mutable: true,
      canonical: opts.canonical ?? true,
      seed: 'oar',
      encoding: packed.encoding,
      compression: packed.compression,
      format: Format.Json,
      dataSource: opts.dataSource ?? DataSource.Direct,
      dataLength: packed.data.length,
      data: packed.data,
    }),
  );
}

async function world() {
  const svm = createSvm();
  const rpc = svmRpc(svm);
  const creator = await fundedSigner(svm);
  const appId = await findAppId({ creator: creator.address, nonce: 0n });
  const program = (await generateKeyPairSigner()).address;
  const manifest: OarManifest = {
    oar: '0.1',
    app_id: appId,
    cluster: CLUSTER,
    name: 'GwapSpot',
    categories: ['marketplace'],
    domains: ['gwapspot.fun'],
    repositories: [{ url: REPO, role: 'program' }],
    programs: [{ address: program, cluster: CLUSTER, name: 'PPV Core' }],
  };
  const ix = await getRegisterInstructionAsync({
    creator,
    nonce: 0n,
    authority: creator.address,
    manifestUri: MANIFEST_URL,
    manifestHash: hashManifest(manifest),
  });
  const res = await send(svm, creator, [ix]);
  assert.ok(res.ok);

  const [metadataPda] = await findCanonicalPda({ program, seed: 'oar' });
  setRawAccount(svm, metadataPda, PROGRAM_METADATA_PROGRAM_ID, backlinkAccount(program, JSON.stringify(buildProgramLink(appId, CLUSTER))));

  const proof = JSON.stringify(buildProofFile([{ appId, cluster: CLUSTER }]));
  const routes: Record<string, { status?: number; body?: string; headers?: Record<string, string> }> = {
    [MANIFEST_URL]: { body: JSON.stringify(manifest, null, 2) },
    'https://gwapspot.fun/.well-known/oar.json': { body: proof },
    [repoProofUrl(REPO)!]: { body: proof },
  };
  return { svm, rpc, creator, appId, program, manifest, metadataPda, routes };
}

const opts = (routes: Parameters<typeof stubFetch>[0], extra: object = {}) => ({
  cluster: CLUSTER,
  fetch: stubFetch(routes),
  resolveTxt: null,
  ...extra,
});

test('resolveProgram: bidirectional links verify end to end', async () => {
  const w = await world();
  const r = await resolveProgram(w.rpc, w.program, opts(w.routes));
  assert.ok(r);
  assert.equal(r.app.appId, w.appId);
  assert.equal(r.app.manifest.ok, true);
  assert.equal(r.link?.state, 'verified');
  assert.equal(r.link?.method, 'program-metadata');
  assert.deepEqual(r.app.domains.map(d => [d.subject, d.state, d.method]), [['gwapspot.fun', 'verified', 'well-known']]);
  assert.deepEqual(r.app.repositories.map(d => [d.state, d.method]), [['verified', 'repo-file']]);
});

test('a program whose backlink names another app is failed, not verified', async () => {
  const w = await world();
  const impostor = await findAppId({ creator: (await generateKeyPairSigner()).address, nonce: 0n });
  setRawAccount(w.svm, w.metadataPda, PROGRAM_METADATA_PROGRAM_ID, backlinkAccount(w.program, JSON.stringify(buildProgramLink(impostor, CLUSTER))));
  const app = await resolveApp(w.rpc, w.appId, opts(w.routes));
  assert.equal(app?.programs[0].state, 'failed');
  // And resolveProgram follows the backlink to the impostor, which does not exist.
  assert.equal(await resolveProgram(w.rpc, w.program, opts(w.routes)), null);
});

test('non-canonical or URL-sourced backlinks are rejected', async () => {
  const w = await world();
  const link = JSON.stringify(buildProgramLink(w.appId, CLUSTER));
  setRawAccount(w.svm, w.metadataPda, PROGRAM_METADATA_PROGRAM_ID, backlinkAccount(w.program, link, { canonical: false }));
  assert.equal((await resolveApp(w.rpc, w.appId, opts(w.routes)))?.programs[0].state, 'failed');
  setRawAccount(w.svm, w.metadataPda, PROGRAM_METADATA_PROGRAM_ID, backlinkAccount(w.program, link, { dataSource: DataSource.Url }));
  assert.equal((await resolveApp(w.rpc, w.appId, opts(w.routes)))?.programs[0].state, 'failed');
});

test('a tampered manifest is unusable and no claims are checked', async () => {
  const w = await world();
  const routes = { ...w.routes, [MANIFEST_URL]: { body: JSON.stringify({ ...w.manifest, name: 'Phantom' }) } };
  const app = await resolveApp(w.rpc, w.appId, opts(routes));
  assert.deepEqual(app?.manifest, { ok: false, reason: 'hash-mismatch' });
  assert.equal(app?.programs.length, 0);
  const missing = await resolveApp(w.rpc, w.appId, opts({}));
  assert.equal(missing?.manifest.ok, false);
  assert.equal((missing?.manifest as { reason: string }).reason, 'unavailable');
});

test('retired apps keep their manifest but show no link chips', async () => {
  const w = await world();
  assert.ok((await send(w.svm, w.creator, [getSetStatusInstruction({ appRecord: w.appId, authority: w.creator, status: 2 })])).ok);
  const app = await resolveApp(w.rpc, w.appId, opts(w.routes));
  assert.equal(app?.status, 'Retired');
  assert.equal(app?.manifest.ok, true);
  assert.equal(app?.programs.length, 0);
  assert.equal(app?.domains.length, 0);
});

test('domain proofs: redirects fail, DNS TXT works, other App IDs are failed', async () => {
  const w = await world();
  const redirect = stubFetch({ 'https://gwapspot.fun/.well-known/oar.json': { status: 301, headers: { location: 'https://evil.example/.well-known/oar.json' } } });
  assert.equal((await checkDomain('gwapspot.fun', w.appId, CLUSTER, { fetch: redirect, resolveTxt: null })).state, 'unverified');

  const dns = async (name: string) => (name === '_oar.gwapspot.fun' ? [[`oar=${CLUSTER}:`, w.appId]] : []);
  const viaDns = await checkDomain('gwapspot.fun', w.appId, CLUSTER, { fetch: stubFetch({}), resolveTxt: dns });
  assert.deepEqual([viaDns.state, viaDns.method], ['verified', 'dns-txt']);

  const other = JSON.stringify(buildProofFile([{ appId: w.program, cluster: CLUSTER }]));
  const res = await checkDomain('gwapspot.fun', w.appId, CLUSTER, { fetch: stubFetch({ 'https://gwapspot.fun/.well-known/oar.json': { body: other } }), resolveTxt: null });
  assert.equal(res.state, 'failed');

  const big = 'x'.repeat(16 * 1024 + 1);
  const tooBig = await checkDomain('gwapspot.fun', w.appId, CLUSTER, { fetch: stubFetch({ 'https://gwapspot.fun/.well-known/oar.json': { body: big } }), resolveTxt: null });
  assert.equal(tooBig.state, 'unverified');
  assert.equal((await checkDomain('GwapSpot.fun', w.appId, CLUSTER, { resolveTxt: null })).state, 'failed');
});

test('trusted SAS attestations require fresh, expiring v2 evidence', async () => {
  const w = await world();
  const credential = (await generateKeyPairSigner()).address;
  const now = 1_800_000_000n;
  const attestation = await putClaim(w.svm, { credential, appId: w.appId, schema: 'oar-domain', subject: 'gwapspot.fun',
    appCluster: CLUSTER, now, payload: { host: 'gwapspot.fun', method: 0 }, expiry: now + 100n });
  const noLive = { live: false, trustedIssuers: [credential], nowSeconds: now };
  let app = await resolveApp(w.rpc, w.appId, opts(w.routes, noLive));
  assert.deepEqual([app?.domains[0].state, app?.domains[0].attestedBy], ['attested', [credential]]);
  for (const expiry of [0n, now, now - 1n, now + 90n * 86400n]) {
    await putClaim(w.svm, { credential, appId: w.appId, schema: 'oar-domain', subject: 'gwapspot.fun',
      appCluster: CLUSTER, now, payload: { host: 'gwapspot.fun', method: 0 }, expiry });
    app = await resolveApp(w.rpc, w.appId, opts(w.routes, noLive));
    assert.equal(app?.domains[0].state, 'unverified');
  }
  await putClaim(w.svm, { credential, appId: w.appId, schema: 'oar-domain', subject: 'gwapspot.fun',
    appCluster: CLUSTER, now, payload: { host: 'gwapspot.fun', method: 0 }, expiry: now + 100n });
  app = await resolveApp(w.rpc, w.appId, opts(w.routes, { ...noLive, trustedIssuers: [] }));
  assert.equal(app?.domains[0].state, 'unverified');
});

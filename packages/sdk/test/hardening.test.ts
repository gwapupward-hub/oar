import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner, getAddressEncoder, type Address } from '@solana/kit';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { findCanonicalPda } from '@solana-program/program-metadata';
import {
  OAR_PROGRAM_ID, SAS_PROGRAM_ID, PROGRAM_METADATA_PROGRAM_ID, OAR_SCHEMAS,
  findAppId, getRegisterInstructionAsync, hashManifest, resolveApp, fetchClaimAttestation,
  deriveSchemaPda, deriveAttestationNonce, decodeAttestation, validateManifest, type OarManifest,
} from '../src/index.js';
import { isPublicAddress, readLimitedText, publicFetch } from '../src/http.js';
import { createSvm, fundedSigner, send, setRawAccount, stubFetch, svmRpc } from './helpers.js';
import { putClaim } from './claim-fixtures.js';
const cluster = 'solana:devnet' as const;
const now = 1_800_000_000n;
const manifestUrl = 'https://cdn.example.com/oar.json';
async function world() {
  const svm = createSvm(); const creator = await fundedSigner(svm);
  const appId = await findAppId({ creator: creator.address, nonce: 0n });
  const program = (await generateKeyPairSigner()).address;
  const credential = (await generateKeyPairSigner()).address;
  const manifest: OarManifest = { oar: '0.1', app_id: appId, cluster, name: 'Regression', categories: ['other'],
    programs: [{ address: program, cluster }, { address: program, cluster: 'solana:mainnet' }],
    domains: ['requested.example'], repositories: [{ url: 'https://github.com/a/b', role: 'app' }] };
  assert.ok((await send(svm, creator, [await getRegisterInstructionAsync({ creator, nonce: 0n,
    authority: creator.address, manifestUri: manifestUrl, manifestHash: hashManifest(manifest) })])).ok);
  return { svm, appId, program, credential, manifest, rpc: svmRpc(svm) };
}
async function domain(w: Awaited<ReturnType<typeof world>>, extra: object = {}) {
  return putClaim(w.svm, { credential: w.credential, appId: w.appId, schema: 'oar-domain',
    subject: 'requested.example', appCluster: cluster, now, payload: { host: 'requested.example', method: 0 }, ...extra });
}
function fetchDomain(w: Awaited<ReturnType<typeof world>>) {
  return fetchClaimAttestation(w.rpc, { credential: w.credential, schema: 'oar-domain', appId: w.appId,
    subject: 'requested.example', appCluster: cluster, nowSeconds: now });
}
function options(w: Awaited<ReturnType<typeof world>>) {
  return { cluster, live: false, trustedIssuers: [w.credential], nowSeconds: now,
    fetch: stubFetch({ [manifestUrl]: { body: JSON.stringify(w.manifest) } }) };
}
test('full domain and repository subjects must match; correct claims remain valid', async () => {
  const w = await world(); await domain(w);
  assert.equal((await fetchDomain(w)).status, 'valid');
  await domain(w, { payload: { host: 'different.example', method: 0 } });
  assert.equal((await fetchDomain(w)).status, 'mismatch');
  for (const url of ['https://github.com/a/b', 'https://github.com/evil/b']) {
    await putClaim(w.svm, { credential: w.credential, appId: w.appId, schema: 'oar-repo',
      subject: 'https://github.com/a/b', appCluster: cluster, now, payload: { url } });
    const app = await resolveApp(w.rpc, w.appId, options(w));
    assert.equal(app?.repositories[0].state, url === 'https://github.com/a/b' ? 'attested' : 'unverified');
  }
});
test('same address on devnet and mainnet receives independent program evidence', async () => {
  const w = await world();
  const args = { credential: w.credential, appId: w.appId, schema: 'oar-program' as const,
    subject: w.program, appCluster: cluster, now, payload: { program: Array.from(getAddressEncoder().encode(w.program)), method: 0 } };
  await putClaim(w.svm, { ...args, programCluster: cluster });
  let app = await resolveApp(w.rpc, w.appId, options(w));
  assert.deepEqual(app?.programs.map(p => p.state), ['attested', 'unverified']);
  await putClaim(w.svm, { ...args, programCluster: 'solana:mainnet' });
  app = await resolveApp(w.rpc, w.appId, options(w));
  assert.deepEqual(app?.programs.map(p => p.state), ['attested', 'attested']);
  await putClaim(w.svm, { ...args, programCluster: 'solana:mainnet', payload: { ...args.payload, program_cluster: cluster } });
  app = await resolveApp(w.rpc, w.appId, options(w));
  assert.deepEqual(app?.programs.map(p => p.state), ['attested', 'unverified']);
});
test('app cluster and program subject cannot be substituted', async () => {
  const w = await world();
  await domain(w, { payload: { host: 'requested.example', method: 0, app_cluster: 'solana:mainnet' } });
  assert.equal((await fetchDomain(w)).status, 'mismatch');
  assert.notEqual(deriveAttestationNonce('oar-domain', w.appId, 'requested.example', { appCluster: cluster }),
    deriveAttestationNonce('oar-domain', w.appId, 'requested.example', { appCluster: 'solana:mainnet' }));
  await putClaim(w.svm, { credential: w.credential, appId: w.appId, schema: 'oar-program', subject: w.program,
    appCluster: cluster, programCluster: cluster, now, payload: { program: Array.from(getAddressEncoder().encode(w.credential)), method: 0 } });
  assert.equal((await resolveApp(w.rpc, w.appId, options(w)))?.programs[0].state, 'unverified');
});
test('schema substitution, pause, wrong owner, and revocation fail closed', async () => {
  const w = await world();
  await domain(w, { schemaLayout: [13, 12, 12, 8, 0] }); assert.equal((await fetchDomain(w)).status, 'invalid');
  await domain(w, { paused: true }); assert.equal((await fetchDomain(w)).status, 'invalid');
  const att = await domain(w);
  const schema = await deriveSchemaPda(w.credential, 'oar-domain', OAR_SCHEMAS['oar-domain'].version);
  const account = w.svm.getAccount(schema); assert.ok(account.exists);
  setRawAccount(w.svm, schema, OAR_PROGRAM_ID, Uint8Array.from(account.data));
  assert.equal((await fetchDomain(w)).status, 'invalid');
  await domain(w); setRawAccount(w.svm, att, '11111111111111111111111111111111' as Address, new Uint8Array());
  assert.equal((await fetchDomain(w)).status, 'invalid');
});
test('all short payloads are invalid without throwing; extra data and unknown methods rejected', async () => {
  const w = await world();
  for (let n = 0; n < 36; n++) {
    await domain(w, { rawData: new Uint8Array(n) }); assert.equal((await fetchDomain(w)).status, 'invalid');
  }
  for (const method of [2, 255]) {
    await domain(w, { payload: { host: 'requested.example', method } }); assert.equal((await fetchDomain(w)).status, 'invalid');
  }
  const address = await domain(w); const account = w.svm.getAccount(address); assert.ok(account.exists);
  const payload = decodeAttestation(Uint8Array.from(account.data)).data;
  await domain(w, { rawData: Uint8Array.from([...payload, 0]) }); assert.equal((await fetchDomain(w)).status, 'invalid');
});
test('timestamp, zero-expiry, excessive TTL, and exact expiry boundary are enforced', async () => {
  const w = await world();
  for (const [checked_at, expiry] of [[now + 1n, now + 100n], [0n, now + 100n], [now, 0n], [now, now + 30n * 86400n + 1n]]) {
    await domain(w, { payload: { host: 'requested.example', method: 0, checked_at }, expiry });
    assert.equal((await fetchDomain(w)).status, 'invalid');
  }
  await domain(w, { payload: { host: 'requested.example', method: 0, checked_at: now - 1n }, expiry: now });
  assert.equal((await fetchDomain(w)).status, 'expired');
});
test('malformed AppRecords return null; malformed metadata does not abort other claims', async () => {
  const w = await world(); const original = w.svm.getAccount(w.appId); assert.ok(original.exists);
  for (const [offset, value] of [[8, 99], [10, 99], [0, 0]]) {
    const data = Uint8Array.from(original.data); data[offset] = value;
    setRawAccount(w.svm, w.appId, OAR_PROGRAM_ID, data); assert.equal(await resolveApp(w.rpc, w.appId, options(w)), null);
  }
  setRawAccount(w.svm, w.appId, OAR_PROGRAM_ID, Uint8Array.from(original.data));
  const other = (await generateKeyPairSigner()).address;
  setRawAccount(w.svm, other, '11111111111111111111111111111111' as Address, new Uint8Array());
  assert.equal(await resolveApp(w.rpc, other, options(w)), null);
  const [metadata] = await findCanonicalPda({ program: w.program, seed: 'oar' });
  setRawAccount(w.svm, metadata, PROGRAM_METADATA_PROGRAM_ID, new Uint8Array(2));
  await domain(w);
  const app = await resolveApp(w.rpc, w.appId, options(w));
  assert.equal(app?.programs[0].state, 'failed'); assert.equal(app?.domains[0].state, 'attested');
});
test('one issuer RPC failure does not abort resolution', async () => {
  const w = await world(); await domain(w);
  const opts = options(w); opts.trustedIssuers.unshift((await generateKeyPairSigner()).address);
  const def = OAR_SCHEMAS['oar-domain'];
  const first = opts.trustedIssuers[0];
  const schema = await deriveSchemaPda(first, 'oar-domain', def.version);
  const { deriveAttestationPda } = await import('../src/index.js');
  const unavailable = await deriveAttestationPda(first, schema, deriveAttestationNonce('oar-domain', w.appId, 'requested.example', { appCluster: cluster }));
  let failures = 0;
  const rpc = { getAccountInfo: (address: Address) => {
    if (address === unavailable) return { send: async () => { failures++; throw new Error('RPC unavailable'); } };
    return w.rpc.getAccountInfo(address);
  } } as typeof w.rpc;
  assert.equal((await resolveApp(rpc, w.appId, opts))?.domains[0].state, 'attested');
  assert.equal(failures, 1);
});
test('Actions host binding and strict manifest minor-version policy', () => {
  const base = { oar: '0.1', app_id: OAR_PROGRAM_ID, cluster, name: 'A', categories: ['other'], domains: ['approved.example'] };
  assert.equal(validateManifest({ ...base, actions: { actions_json: 'https://unrelated.example/actions.json' } }).valid, false);
  assert.equal(validateManifest({ ...base, actions: { actions_json: 'https://approved.example/actions.json' } }).valid, true);
  assert.equal(validateManifest({ ...base, oar: '0.2' }).valid, false);
});
test('private URLs, redirects and alternative IP spellings never reach transport', async () => {
  let calls = 0;
  const fetch = (async () => { calls++; return new Response('{}'); }) as typeof globalThis.fetch;
  for (const url of ['https://127.0.0.1/x', 'https://0x7f000001/x', 'https://2130706433/x', 'https://10.0.0.1/',
    'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://localhost/', 'https://a.internal/', 'https://user:pass@example.com/', 'https://example.com:444/']) {
    await assert.rejects(readLimitedText(url, { fetch, maxBytes: 100, timeoutMs: 100, maxRedirects: 3 }));
  }
  assert.equal(calls, 0);
  const redirect = (async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }); }) as typeof globalThis.fetch;
  await assert.rejects(readLimitedText('https://public.example/', { fetch: redirect, maxBytes: 100, timeoutMs: 100, maxRedirects: 3 }));
  assert.equal(calls, 1);
});
test('public destination classification rejects special IPv4/IPv6 ranges', () => {
  for (const ip of ['0.0.0.0','100.64.0.1','172.31.0.1','192.168.0.1','198.18.0.1','203.0.113.1','224.0.0.1',
    'fe80::1','fc00::1','2001:db8::1','2001:0db8::1','2002::1','3fff::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});
test('DNS-resolved private destinations and mixed answers fail before connecting', async () => {
  for (const answers of [[{ address: '10.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]]) {
    let calls = 0;
    await assert.rejects(publicFetch('https://public.example/', {}, { lookup: (async () => answers) as never,
      request: (() => { calls++; throw new Error('must not connect'); }) as never }));
    assert.equal(calls, 0);
  }
});
test('validated DNS address is pinned at TLS connect, preserving original hostname', async () => {
  let lookups = 0;
  const response = new PassThrough() as PassThrough & { headers: object; statusCode: number };
  response.headers = {}; response.statusCode = 200;
  const request = ((url: URL, options: { lookup: Function; agent: boolean }, cb: Function) => {
    assert.equal(url.hostname, 'public.example'); assert.equal(options.agent, false);
    options.lookup('public.example', {}, (err: unknown, ip: string, family: number) => {
      assert.equal(err, null); assert.equal(ip, '8.8.8.8'); assert.equal(family, 4);
    });
    const req = new EventEmitter() as EventEmitter & { end: Function };
    req.end = () => { cb(response); response.end('{}'); }; return req;
  }) as never;
  const res = await publicFetch('https://public.example/', {}, { lookup: (async () => { lookups++; return [{ address: '8.8.8.8', family: 4 }]; }) as never, request });
  assert.equal(await res.text(), '{}'); assert.equal(lookups, 1);
});
test('uncooperative headers and body are bounded; excess bodies rejected', async () => {
  await assert.rejects(readLimitedText('https://public.example/', { fetch: (async () => new Promise(() => {})) as typeof fetch,
    maxBytes: 10, timeoutMs: 20, maxRedirects: 0 }), /Deadline/);
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readLimitedText('https://public.example/', { fetch: (async () => new Response(body)) as typeof fetch,
    maxBytes: 10, timeoutMs: 20, maxRedirects: 0 }), /Deadline/);
  assert.equal(cancelled, true);
  await assert.rejects(readLimitedText('https://public.example/', { fetch: (async () => new Response('x'.repeat(11))) as typeof fetch,
    maxBytes: 10, timeoutMs: 100, maxRedirects: 0 }), /large/);
});

test('DNS TXT lookups that never finish cannot stall domain checks', async () => {
  const { checkDomain } = await import('../src/index.js');
  const result = await checkDomain('public.example', OAR_PROGRAM_ID, cluster, {
    fetch: stubFetch({}), timeoutMs: 20, resolveTxt: () => new Promise(() => {}),
  });
  assert.equal(result.state, 'unverified'); assert.match(result.detail!, /Deadline/);
});
test('repository proof endpoints require exact root URLs', async () => {
  const { repoProofUrl } = await import('../src/index.js');
  for (const url of ['https://github.com/a/b/tree/evil', 'https://user@github.com/a/b', 'https://github.com/a/b?ref=other', 'https://gitlab.com/a/b/-/tree/evil']) assert.equal(repoProofUrl(url), null);
  assert.equal(repoProofUrl('https://github.com/a/b.git'), 'https://raw.githubusercontent.com/a/b/HEAD/oar.json');
});
test('attestation nonce and full app ID bytes are checked', async () => {
  const w = await world(); const address = await domain(w);
  const account = w.svm.getAccount(address); assert.ok(account.exists);
  const bytes = Uint8Array.from(account.data); bytes[1] ^= 1;
  setRawAccount(w.svm, address, SAS_PROGRAM_ID, bytes);
  assert.equal((await fetchDomain(w)).status, 'mismatch');
  await domain(w, { payload: { host: 'requested.example', method: 0, app_id: Array.from(getAddressEncoder().encode(w.credential)) } });
  assert.equal((await fetchDomain(w)).status, 'mismatch');
});
test('actual schema field names cannot be substituted at an expected schema PDA', async () => {
  const w = await world(); await domain(w);
  const schema = await deriveSchemaPda(w.credential, 'oar-domain', 2);
  const account = w.svm.getAccount(schema); assert.ok(account.exists);
  const bytes = Uint8Array.from(account.data);
  const marker = Buffer.from(bytes).indexOf(Buffer.from('checked_at'));
  assert.ok(marker > 0); bytes[marker] = 'x'.charCodeAt(0);
  setRawAccount(w.svm, schema, SAS_PROGRAM_ID, bytes);
  assert.equal((await fetchDomain(w)).status, 'invalid');
});
test('compressed backlink bombs fail without aborting unrelated claims', async () => {
  const { Compression, Encoding, Format, DataSource, getMetadataEncoder, packDirectData } = await import('@solana-program/program-metadata');
  const w = await world(); await domain(w);
  const packed = packDirectData({ content: 'x'.repeat(1024 * 1024), compression: Compression.Zlib, encoding: Encoding.Utf8 });
  const [metadata] = await findCanonicalPda({ program: w.program, seed: 'oar' });
  setRawAccount(w.svm, metadata, PROGRAM_METADATA_PROGRAM_ID, Uint8Array.from(getMetadataEncoder().encode({
    program: w.program, authority: null, mutable: true, canonical: true, seed: 'oar', format: Format.Json,
    dataSource: DataSource.Direct, encoding: packed.encoding, compression: packed.compression,
    dataLength: packed.data.length, data: packed.data,
  })));
  const app = await resolveApp(w.rpc, w.appId, options(w));
  assert.equal(app?.programs[0].state, 'failed'); assert.equal(app?.domains[0].state, 'attested');
});

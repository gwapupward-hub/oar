import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSigner } from '@solana/kit';
import { buildClaimFiles, checkDomain, checkManifestHosting, checkManifestUri, checkRepository } from '../src/index.js';
import { checkManifestUri as checkFromRegisterEntry } from '../src/register.js';
import { stubFetch } from './helpers.js';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);
const CLUSTER = 'solana:devnet' as const;

export const ACCEPTED_MANIFEST_URIS = [
  'ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U',
  'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  'https://myapp.xyz/.well-known/oar-manifest.json',
  `https://raw.githubusercontent.com/me/app/${SHA1}/oar-manifest.json`,
  `https://raw.githubusercontent.com/me/app/${SHA256}/release/oar.manifest.json`,
  `https://github.com/me/app/raw/${SHA1}/oar-manifest.json`,
  `https://gitlab.com/group/sub/app/-/raw/${SHA1}/oar-manifest.json`,
  `https://cdn.jsdelivr.net/gh/me/app@${SHA1}/oar-manifest.json`,
];

export const REFUSED_MANIFEST_URIS = [
  'https://raw.githubusercontent.com/me/app/refs/heads/main/oar-manifest.json',
  'https://raw.githubusercontent.com/me/app/HEAD/oar-manifest.json',
  'https://raw.githubusercontent.com/me/app/main/oar-manifest.json',
  'https://raw.githubusercontent.com/me/app/v1.0.0/oar-manifest.json',
  `https://raw.githubusercontent.com/me/app/${SHA1.slice(0, 7)}/oar-manifest.json`,
  `https://raw.githubusercontent.com/me/app/${SHA1.toUpperCase()}/oar-manifest.json`,
  'https://github.com/me/app/raw/main/oar-manifest.json',
  'https://github.com/me/app/blob/HEAD/oar-manifest.json',
  'https://github.com/me/app/releases/download/v1/oar-manifest.json',
  'https://gitlab.com/group/app/-/raw/main/oar-manifest.json',
  'https://cdn.jsdelivr.net/gh/me/app@main/oar-manifest.json',
  'https://cdn.jsdelivr.net/gh/me/app/oar-manifest.json',
  // `oar.json` is reserved for proofs, even when commit-pinned or on the app's own domain.
  'https://myapp.xyz/.well-known/oar.json',
  `https://raw.githubusercontent.com/me/app/${SHA1}/oar.json`,
  'https://myapp.xyz/OAR.JSON',
  'http://myapp.xyz/oar-manifest.json',
  'https://user:pass@myapp.xyz/oar-manifest.json',
  'ar://',
  `https://myapp.xyz/${'x'.repeat(260)}.json`,
];

test('manifest URI policy accepts content-addressed and commit-pinned locations', () => {
  for (const uri of ACCEPTED_MANIFEST_URIS) assert.deepEqual(checkManifestUri(uri), { ok: true }, uri);
});

test('manifest URI policy refuses mutable refs and the reserved proof file name', () => {
  for (const uri of REFUSED_MANIFEST_URIS) {
    const r = checkManifestUri(uri);
    assert.equal(r.ok, false, uri);
    assert.equal(checkFromRegisterEntry(uri).ok, false, `browser entry agrees: ${uri}`);
  }
  const mutable = checkManifestUri('https://raw.githubusercontent.com/me/app/refs/heads/main/oar-manifest.json');
  assert.ok(!mutable.ok && /mutable reference "refs".*full commit SHA/.test(mutable.detail));
  const reserved = checkManifestUri('https://myapp.xyz/.well-known/oar.json');
  assert.ok(!reserved.ok && /reserved for domain and repository proofs/.test(reserved.detail));
});

test('hosting check refuses an unsafe URI before fetching it', async () => {
  let fetched = false;
  const fetch = (async () => { fetched = true; return new Response('{}'); }) as typeof globalThis.fetch;
  const r = await checkManifestHosting('https://raw.githubusercontent.com/me/app/main/oar-manifest.json', {}, { fetch });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'unsafe-uri');
  assert.equal(fetched, false);
});

test('claim files refuse a manifest URI that would collide with a proof or follow a branch', async () => {
  const appId = (await generateKeyPairSigner()).address;
  const base = { appId, cluster: CLUSTER, name: 'Example', domains: ['myapp.xyz'], repositories: ['https://github.com/me/app'] };
  assert.throws(() => buildClaimFiles({ ...base, manifestUri: 'https://myapp.xyz/.well-known/oar.json' }), /reserved/);
  assert.throws(() => buildClaimFiles({ ...base, manifestUri: 'https://raw.githubusercontent.com/me/app/HEAD/oar-manifest.json' }), /mutable/);
  const files = buildClaimFiles(base);
  assert.equal(files.manifestUri, 'https://myapp.xyz/.well-known/oar-manifest.json');
  assert.ok(files.repoProof, 'repository proof stays a separate file');
});

test('domain and repository checks flag transient outages as retryable, never failed', async () => {
  const appId = (await generateKeyPairSigner()).address;
  const down = stubFetch({
    'https://myapp.xyz/.well-known/oar.json': { status: 503 },
    'https://raw.githubusercontent.com/me/app/HEAD/oar.json': { status: 502 },
  });
  const domain = await checkDomain('myapp.xyz', appId, CLUSTER, { fetch: down, resolveTxt: null });
  assert.equal(domain.state, 'unverified');
  assert.equal(domain.retryable, true);
  const repo = await checkRepository('https://github.com/me/app', appId, CLUSTER, { fetch: down });
  assert.equal(repo.state, 'unverified');
  assert.equal(repo.retryable, true);

  const dnsTimeout = async () => { throw Object.assign(new Error('queryTxt ETIMEOUT'), { code: 'ETIMEOUT' }); };
  const viaDns = await checkDomain('myapp.xyz', appId, CLUSTER, { fetch: stubFetch({}), resolveTxt: dnsTimeout });
  assert.equal(viaDns.retryable, true, 'a DNS resolver that could not answer is not absence');

  // Absence that was actually observed is plain unverified, not retryable.
  const dnsAbsent = async () => { throw Object.assign(new Error('queryTxt ENODATA'), { code: 'ENODATA' }); };
  const missing = await checkDomain('myapp.xyz', appId, CLUSTER, { fetch: stubFetch({}), resolveTxt: dnsAbsent });
  assert.equal(missing.state, 'unverified');
  assert.equal(missing.retryable, undefined);
  const noRepoProof = await checkRepository('https://github.com/me/app', appId, CLUSTER, { fetch: stubFetch({}) });
  assert.equal(noRepoProof.retryable, undefined);
});

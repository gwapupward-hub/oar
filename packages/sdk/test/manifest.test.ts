import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildProgramLink,
  buildProofFile,
  canonicalizeManifest,
  checkManifest,
  hashManifest,
  hashManifestHex,
  manifestUriToUrl,
  validateManifest,
  validateProgramLink,
  validateProofFile,
} from '../src/index.js';
import { manifestSchema, programLinkSchema, wellKnownSchema } from '../src/schemas.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const example = readJson('examples/manifest.example.json');

test('embedded schemas match /schema (run scripts/sync-schemas.mjs if this fails)', () => {
  assert.deepEqual(manifestSchema, readJson('schema/manifest-0.1.schema.json'));
  assert.deepEqual(wellKnownSchema, readJson('schema/well-known-0.1.schema.json'));
  assert.deepEqual(programLinkSchema, readJson('schema/program-link-0.1.schema.json'));
});

test('example manifest is valid', () => {
  const v = validateManifest(example);
  assert.ok(v.valid, v.errors.join('\n'));
});

test('RFC 8785: key order and whitespace do not change the hash', () => {
  assert.equal(new TextDecoder().decode(canonicalizeManifest({ b: 2, a: [1, { d: 'x', c: true }] })), '{"a":[1,{"c":true,"d":"x"}],"b":2}');
  const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(example).reverse()), null, 4));
  assert.equal(hashManifestHex(reordered), hashManifestHex(example));
  assert.equal(hashManifest(example).length, 32);
});

test('schema rejections', () => {
  const bad = (patch: Record<string, unknown>) => validateManifest({ ...example, ...patch });
  assert.equal(bad({ name: '' }).valid, false);
  assert.equal(bad({ categories: [] }).valid, false);
  assert.equal(bad({ categories: ['casino'] }).valid, false);
  assert.equal(bad({ cluster: 'mainnet-beta' }).valid, false);
  assert.equal(bad({ domains: ['GwapSpot.fun'] }).valid, false, 'hostnames must be lowercase');
  assert.equal(bad({ domains: ['xn--e1afmkfd.xn--p1ai'] }).valid, true, 'punycode IDNs are allowed');
  assert.equal(bad({ links: { website: 'http://gwapspot.fun' } }).valid, false, 'https only');
  assert.equal(bad({ unknown_field: 1 }).valid, false);
  assert.equal(bad({ extensions: { 'fun.gwapspot': { score: 1.5 } } }).valid, false, 'non-integer numbers are rejected');
  assert.equal(bad({ extensions: { gwapspot: {} } }).valid, false, 'extension keys are reverse-DNS');
  assert.equal(bad({ programs: [{ address: '0OIl', cluster: 'solana:devnet' }] }).valid, false);
});

test('checkManifest enforces hash, schema, app_id and cluster binding', () => {
  const expected = { appId: example.app_id, cluster: 'solana:devnet' as const, manifestHash: hashManifest(example) };
  assert.equal(checkManifest(example, expected).ok, true);
  assert.deepEqual(checkManifest({ ...example, name: 'Phantom' }, expected), { ok: false, reason: 'hash-mismatch' });

  const otherApp = { ...example, app_id: '5hiqrftDiJ2EKcU4kUzvXWCdbMoEiWyJTqKjUNG5jqoo' };
  assert.equal((checkManifest(otherApp, { ...expected, manifestHash: hashManifest(otherApp) }) as { reason: string }).reason, 'app-id-mismatch');

  const mainnet = { ...example, cluster: 'solana:mainnet' };
  assert.equal((checkManifest(mainnet, { ...expected, manifestHash: hashManifest(mainnet) }) as { reason: string }).reason, 'cluster-mismatch');
});

test('proof file and program link builders produce schema-valid JSON', () => {
  assert.ok(validateProofFile(buildProofFile([{ appId: example.app_id, cluster: 'solana:mainnet' }])).valid);
  assert.ok(validateProgramLink(buildProgramLink(example.app_id, 'solana:mainnet')).valid);
  assert.equal(validateProofFile({ oar: '0.1', apps: [] }).valid, false);
});

test('manifest URI schemes map to gateways; others are refused', () => {
  assert.equal(manifestUriToUrl('ar://abc'), 'https://arweave.net/abc');
  assert.equal(manifestUriToUrl('ipfs://bafy'), 'https://ipfs.io/ipfs/bafy');
  assert.equal(manifestUriToUrl('https://a.b/c'), 'https://a.b/c');
  assert.throws(() => manifestUriToUrl('http://a.b/c'));
});

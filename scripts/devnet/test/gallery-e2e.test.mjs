import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gateStatus, remainingSignedSteps } from '../gallery-e2e.mjs';

test('remaining signed steps follow observed state, never assumptions', () => {
  assert.match(remainingSignedSteps({ registered: false, recordManifestMatches: false, programs: [] })[0], /creator wallet signs/);
  assert.match(remainingSignedSteps({ registered: true, recordManifestMatches: false, programs: [] })[0], /record authority signs a manifest update/);
  assert.deepEqual(remainingSignedSteps({ registered: true, recordManifestMatches: true, programs: [{ program: 'P', backlink: 'verified' }] }), []);
  const [link] = remainingSignedSteps({ registered: true, recordManifestMatches: true, programs: [{ program: 'P', backlink: 'unverified', upgradeAuthority: 'A' }] });
  assert.match(link, /upgrade authority A signs/);
  const [frozen] = remainingSignedSteps({ registered: true, recordManifestMatches: true, programs: [{ program: 'P', backlink: 'unverified', upgradeAuthority: null }] });
  assert.match(frozen, /attestation/);
});

test('the gate is PASS only for a registered, matching record with every claim verified', () => {
  const expectedClaims = [{ kind: 'program', subject: 'P' }, { kind: 'domain', subject: 'd.example' }];
  const claims = expectedClaims.map(c => ({ ...c, state: 'verified' }));
  const base = { preflightErrors: [], hosting: { ok: true }, registered: true, recordManifestMatches: true,
    resolved: { status: 'Active', manifest: 'ok' }, expectedClaims, claims, remaining: [] };
  assert.equal(gateStatus(base), 'PASS');
  assert.equal(gateStatus({ ...base, registered: false, remaining: ['x'] }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, recordManifestMatches: false, remaining: ['x'] }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, claims: [{ ...claims[0], state: 'unverified' }, claims[1]] }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, claims: [{ ...claims[0], state: 'attested' }, claims[1]] }), 'BLOCKED', 'attested is not reciprocal evidence');
  assert.equal(gateStatus({ ...base, claims: [{ ...claims[0], state: 'failed' }, claims[1]] }), 'FAIL');
  assert.equal(gateStatus({ ...base, preflightErrors: ['manifest URI: mutable'] }), 'FAIL');
  assert.equal(gateStatus({ ...base, hosting: { ok: false, reason: 'unreachable' } }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, hosting: { ok: false, reason: 'different' } }), 'FAIL');
  assert.equal(gateStatus({ ...base, hosting: { ok: false, reason: 'unsafe-uri' } }), 'FAIL');
  assert.equal(gateStatus({ ...base, resolved: null, claims: [] }), 'BLOCKED', 'unavailable resolver cannot vacuously pass');
  assert.equal(gateStatus({ ...base, resolved: { status: 'Active', manifest: 'unavailable' }, claims: [] }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, resolved: { status: 'Active', manifest: 'hash-mismatch' } }), 'FAIL');
  assert.equal(gateStatus({ ...base, resolved: { status: 'Inactive', manifest: 'ok' } }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, claims: [] }), 'BLOCKED', 'empty resolved links cannot pass');
  assert.equal(gateStatus({ ...base, claims: [claims[0]] }), 'BLOCKED', 'a missing declared link blocks');
  assert.equal(gateStatus({ ...base, claims: [claims[0], { ...claims[1], subject: 'other.example' }] }), 'BLOCKED');
  assert.equal(gateStatus({ ...base, claims: [...claims, claims[0]] }), 'BLOCKED', 'unexpected claims do not pass');
  assert.equal(gateStatus({ ...base, expectedClaims: [] , claims: [] }), 'BLOCKED', 'gallery E2E must test at least one link');
});

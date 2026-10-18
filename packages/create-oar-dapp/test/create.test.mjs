import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(root, 'packages/create-oar-dapp/bin/create-oar-dapp.mjs');
const creator = '91N96ZPGHcFWe2jEZie9rUVqyHF5BWMV7mYnHMurhWB7';
function withTemp(fn) {
  const dir = mkdtempSync(join(root, '.oar-starter-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function run(cwd, path, args) {
  return spawnSync(process.execPath, [path, ...args], { cwd, encoding: 'utf8' });
}

test('starter generator produces a complete but unsigned Next.js project', () => withTemp(tmp => {
  const r = run(tmp, cli, ['example-app', '--name', 'Example App', '--domain', 'example.org',
    '--repo', 'https://github.com/example/example-app', '--category', 'infrastructure']);
  assert.equal(r.status, 0, r.stderr);
  const project = join(tmp, 'example-app');
  const cfg = JSON.parse(readFileSync(join(project, 'oar.config.json'), 'utf8'));
  assert.equal(cfg.name, 'Example App');
  assert.equal(cfg.cluster, 'solana:devnet');
  assert.equal(cfg.domain, 'example.org');
  assert.deepEqual(cfg.repositories, ['https://github.com/example/example-app']);
  assert.ok(existsSync(join(project, 'src/app/page.tsx')));
  assert.ok(existsSync(join(project, 'scripts/prepare-oar.mjs')));
  assert.ok(existsSync(join(project, 'scripts/import-anchor-programs.mjs')));
  assert.ok(existsSync(join(project, 'src/lib/oar.ts')));
  assert.ok(!existsSync(join(project, 'public/.well-known/oar.json')),
    'proofs must not be written before creator public address is provided');
  assert.ok(!readdirSync(project).some(p => p.includes('keypair')));
  assert.match(r.stdout, /not|Created/i);
}));

test('invalid paths, hosts and options are rejected without generating files', () => withTemp(tmp => {
  for (const args of [
    ['../escape'], ['my-app', '--domain', 'http://example.org'],
    ['my-app', '--domain', 'localhost'], ['my-app', '--bad'],
    ['my-app', '--repo', 'git@github.com:user/repo'],
    ['my-app', '--category', 'madeup'],
  ]) {
    const r = run(tmp, cli, args);
    assert.notEqual(r.status, 0, 'Must reject ' + args.join(' '));
  }
  assert.deepEqual(readdirSync(tmp), []);
}));

test('generator never overwrites an existing directory', () => withTemp(tmp => {
  assert.equal(run(tmp, cli, ['my-app']).status, 0);
  const second = run(tmp, cli, ['my-app']);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /overwrite/);
}));

test('offline preparation uses the existing SDK, creates valid proofs, and refuses overwrites', () => withTemp(tmp => {
  assert.equal(run(tmp, cli, ['new-dapp', '--name', 'New Dapp', '--domain', 'example.org',
    '--repo', 'https://github.com/example/new-dapp']).status, 0);
  const project = join(tmp, 'new-dapp');
  const prep = join(project, 'scripts/prepare-oar.mjs');
  const result = run(project, prep, ['--creator', creator]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Not registered/);
  const manifest = JSON.parse(readFileSync(join(project, 'public/.well-known/oar-manifest.json'), 'utf8'));
  const domain = JSON.parse(readFileSync(join(project, 'public/.well-known/oar.json'), 'utf8'));
  const repoProof = JSON.parse(readFileSync(join(project, 'oar.json'), 'utf8'));
  assert.equal(manifest.oar, '0.1');
  assert.equal(manifest.cluster, 'solana:devnet');
  assert.equal(domain.apps[0].app_id, manifest.app_id);
  assert.equal(repoProof.apps[0].app_id, manifest.app_id);
  assert.equal(manifest.domains[0], 'example.org');
  assert.match(result.stdout, /Manifest SHA-256 \(RFC 8785\): [a-f0-9]{64}/);
  assert.notEqual(run(project, prep, ['--creator', creator]).status, 0);
  assert.equal(run(project, prep, ['--creator', creator, '--force']).status, 0);
  assert.notEqual(run(project, prep, ['--creator', 'not-a-key']).status, 0);
}));

test('invalid config cannot produce a valid-looking manifest', () => withTemp(tmp => {
  assert.equal(run(tmp, cli, ['invalid-app', '--domain', 'example.org']).status, 0);
  const project = join(tmp, 'invalid-app');
  const cfgPath = join(project, 'oar.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.category = 'not-a-category';
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const r = run(project, join(project, 'scripts/prepare-oar.mjs'), ['--creator', creator]);
  assert.notEqual(r.status, 0);
  assert.ok(!existsSync(join(project, 'public/.well-known/oar-manifest.json')));
}));

test('Anchor adapter previews only, imports public Devnet addresses after approval, and protects existing links', () => withTemp(tmp => {
  assert.equal(run(tmp, cli, ['with-anchor', '--domain', 'example.org']).status, 0);
  const project = join(tmp, 'with-anchor');
  const anchorWorkspace = join(tmp, 'anchor');
  mkdirSync(anchorWorkspace);
  const anchorToml = join(anchorWorkspace, 'Anchor.toml');
  const id = 'oariw8YXcYJh9sa9VcmBU3ZCdo2WVGMYPsLjEuUxfrC';
  writeFileSync(anchorToml, '[programs.localnet]\nlocal = "11111111111111111111111111111111"\n[programs.devnet]\nmy_program = "' + id + '"\n');
  const importer = join(project, 'scripts/import-anchor-programs.mjs');
  const params = ['--workspace', anchorWorkspace];
  const preview = run(project, importer, params);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Preview only/);
  const configPath = join(project, 'oar.config.json');
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).programs, []);
  const approve = run(project, importer, [...params, '--yes']);
  assert.equal(approve.status, 0, approve.stderr);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).programs, [id]);
  assert.equal(run(project, importer, [...params, '--yes']).status, 0);
  writeFileSync(anchorToml, '[programs.devnet]\nsecond = "' + creator + '"\n');
  assert.notEqual(run(project, importer, [...params, '--yes']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).programs, [id]);
  assert.equal(run(project, importer, [...params, '--yes', '--replace']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).programs, [creator]);
  writeFileSync(anchorToml, '[programs.devnet]\nduplicate = "' + creator + '"\nduplicate = "' + id + '"\n');
  assert.notEqual(run(project, importer, [...params, '--yes', '--replace']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).programs, [creator]);
}));

test('Anchor adapter rejects malformed config, missing files and unknown options', () => withTemp(tmp => {
  assert.equal(run(tmp, cli, ['invalid-anchor', '--domain', 'example.org']).status, 0);
  const project = join(tmp, 'invalid-anchor');
  const importer = join(project, 'scripts/import-anchor-programs.mjs');
  assert.notEqual(run(project, importer, ['--bad']).status, 0);
  assert.notEqual(run(project, importer, ['--workspace', tmp]).status, 0);
}));

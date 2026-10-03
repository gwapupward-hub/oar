import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { address } from '@solana/kit';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const exposed = 'oarWKQoXgxp69Vupf883Pr1PvN35rAyZJeFu8q4pae5';
const failures = [];
const idl = JSON.parse(read('idl/oar_registry.json')).address;
try { address(idl); } catch { failures.push('Invalid IDL public address'); }
const rust = read('programs/oar-registry/src/lib.rs').match(/declare_id!\("([^"]+)"\)/)?.[1];
const ids = [...read('Anchor.toml').matchAll(/oar_registry\s*=\s*"([^"]+)"/g)].map(m => m[1]);
const generated = read('packages/sdk/src/generated/programs/oarRegistry.ts');
if (rust !== idl || !ids.length || ids.some(id => id !== idl) || !generated.includes(`"${idl}"`)) failures.push('Program identity drift');
function scan(dir) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'target', 'dist'].includes(name)) continue;
    const path = join(dir, name), rel = relative(root, path);
    if (statSync(path).isDirectory()) { scan(path); continue; }
    if (/(?:keypair|wallet|secret|credential)[^/]*\.(?:json|pem|key)$/i.test(name) || name === 'id.json' || /^\.env(?:\.|$)/.test(name)) failures.push(`Forbidden file: ${rel}`);
    if (name.endsWith('.json')) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(data) && [32, 64].includes(data.length) && data.every(v => Number.isInteger(v) && v >= 0 && v <= 255)) failures.push(`Signer-shaped JSON: ${rel}`);
      } catch {}
    }
    if (/\.(?:json|ts|rs|md|ya?ml|toml|txt|mjs)$/.test(name)) {
      const bytes = readFileSync(path, 'utf8');
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes)) failures.push(`Private key block: ${rel}`);
    }
  }
}
scan(root);
if (process.argv.includes('--production')) {
  const c = JSON.parse(read('release/production.json'));
  if (idl === exposed) failures.push('Exposed reference program identity is forbidden for release');
  if (c.programId !== idl) failures.push('Release program ID is unset or inconsistent');
  if (!/^.+@sha256:[0-9a-f]{64}$/.test(c.builderImage ?? '')) failures.push('Digest-pinned builder image is required');
  if (!/^[0-9a-f]{40}$/.test(c.sourceCommit ?? '')) failures.push('Approved source commit required');
  for (const gate of ['reproducibleBuild', 'rustTests', 'freshBinaryTests', 'dependencyReview', 'independentReview', 'devnetRehearsal', 'sasCompatibility', 'governance', 'operations']) {
    const file = c.evidence?.[gate];
    if (typeof file !== 'string' || file.startsWith('/') || file.split('/').includes('..') || !existsSync(join(root, file))) failures.push(`Missing release evidence: ${gate}`);
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`Identity and source secret checks passed (${idl}).${idl === exposed ? ' LOCAL TEST IDENTITY ONLY.' : ''}`);

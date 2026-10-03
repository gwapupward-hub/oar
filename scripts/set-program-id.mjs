// Accepts only a PUBLIC address. This script never reads or generates signer material.
import { readFileSync, writeFileSync } from 'node:fs';
import { address } from '@solana/kit';
import { execFileSync } from 'node:child_process';
const next = address(process.argv[2]);
const old = JSON.parse(readFileSync('idl/oar_registry.json', 'utf8')).address;
if (next === 'oarWKQoXgxp69Vupf883Pr1PvN35rAyZJeFu8q4pae5') throw new Error('Exposed identity forbidden');
for (const path of ['programs/oar-registry/src/lib.rs', 'Anchor.toml', 'idl/oar_registry.json']) {
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll(old, next));
}
execFileSync(process.execPath, ['scripts/generate-client.mjs'], { stdio: 'inherit' });
console.log('Public identity synchronized. Rebuild and test a FRESH binary before any release.');

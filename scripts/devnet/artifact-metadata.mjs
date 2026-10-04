// CI: describe a freshly built program artifact for the devnet operator scripts.
//
//   node scripts/devnet/artifact-metadata.mjs --so <path> --builder <image@sha256:...> \
//     --versions <file> --double-build-match <true|false> --out <build-metadata.json>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { declaredProgramId, executableHash, readJson, root, run, sha256, writeJson } from './lib.mjs';

const { values: o } = parseArgs({
  options: {
    so: { type: 'string' },
    builder: { type: 'string' },
    versions: { type: 'string' },
    'double-build-match': { type: 'string' },
    out: { type: 'string' },
  },
});
for (const k of ['so', 'builder', 'versions', 'double-build-match', 'out']) if (!o[k]) throw new Error(`--${k} is required`);

const pinned = readJson(join(root, 'release/devnet.json')).builderImage;
if (o.builder !== pinned) throw new Error(`Builder ${o.builder} is not the pinned ${pinned}`);

const so = readFileSync(o.so);
const env = process.env;
writeJson(o.out, {
  repo_sha: env.GITHUB_SHA ?? run('git', ['rev-parse', 'HEAD']),
  program_id: declaredProgramId(),
  builder_image: o.builder,
  tool_versions: readFileSync(o.versions, 'utf8').split('\n').map(l => l.trim()).filter(Boolean),
  artifact: 'oar_registry.so',
  artifact_bytes: so.length,
  artifact_sha256: sha256(so),
  executable_hash: executableHash(so),
  idl_sha256: sha256(readFileSync(join(root, 'idl/oar_registry.json'))),
  double_build_match: o['double-build-match'] === 'true',
  built_at: new Date().toISOString(),
  ci_run_url: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
});
console.log(`Wrote ${o.out}`);

// Regenerates packages/sdk/src/generated from the Anchor IDL with Codama.
// Run after any change to the program: `npm run generate`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const idl = JSON.parse(readFileSync(join(root, 'idl/oar_registry.json'), 'utf8'));
const codama = createFromRoot(rootNodeFromAnchor(idl));

await codama.accept(
  renderVisitor(join(root, 'packages/sdk'), {
    generatedFolder: 'src/generated',
    deleteFolderBeforeRendering: true, // clears src/generated only
    syncPackageJson: false,
    importExtension: 'js',
    formatCode: true,
  }),
);
console.log('Generated packages/sdk/src/generated');

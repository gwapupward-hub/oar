# OAR devnet deployment runbook

Scope: the first official deployment of `oar-registry` to Solana devnet, and later devnet upgrades. Mainnet stays **NO-GO** (see `PRODUCTION-READINESS.md`).

This runbook authorizes nothing by itself. Every onchain step needs `--confirm <PROGRAM_ID>`. Every script refuses any RPC whose genesis hash is not devnet's (`EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`).

## Keys: three distinct roles

| Key | Purpose | Where it lives |
| --- | --- | --- |
| Program ID keypair | Permanent identity. It signs only the first deploy on each cluster. The same ID is planned for mainnet, so the devnet-verified artifact can be promoted. | Offline. Never in the repo, CI, chat or logs. |
| Devnet upgrade authority | Signs deploys/upgrades and the canonical Program Metadata (IDL). | Operator machine. |
| Devnet fee payer | Pays rent and fees. Creates the throwaway smoke-test App ID. | Operator machine. Fund it with ≥ 3 SOL. |

The preflight refuses to run if any two of these are the same key, or if any of them is the exposed reference ID `oarWKQ…pae5`.

Create the keys once, privately, **outside this repository**:

```bash
mkdir -p ~/.config/solana/oar && chmod 700 ~/.config/solana/oar && cd ~/.config/solana/oar
solana-keygen grind --starts-with oar:1          # writes <PROGRAM_ID>.json; the prefix is optional
solana-keygen new -o devnet-upgrade-authority.json
solana-keygen new -o devnet-payer.json
solana airdrop 2 "$(solana-keygen pubkey devnet-payer.json)" -u devnet   # or https://faucet.solana.com, until ≥ 3 SOL
```

Only the program's **public** address is shared.

**Fund only the fee payer. Never send SOL to the program ID before its first deploy.** The first deploy has to create the program account itself, so a funded address blocks it. If it happens, the preflight reports it. Return the SOL with the program keypair, then re-run the preflight:

```bash
solana transfer <FEE_PAYER_PUBKEY> ALL --from ~/.config/solana/oar/<PROGRAM_ID>.json \
  --fee-payer ~/.config/solana/oar/<PROGRAM_ID>.json --allow-unfunded-recipient -u devnet
solana account <PROGRAM_ID> -u devnet    # expect AccountNotFound
```

## 1. Set the identity (pull request)

```bash
node scripts/set-program-id.mjs <PROGRAM_ID>     # source, Anchor.toml, IDL and generated client
npm run build && npm run test:cli && npm run check:source
```

Commit and open a PR. CI then does the following:

1. Builds the program from source in the pinned builder (`release/devnet.json` → `builderImage`).
2. Runs rustfmt, clippy and the Rust unit tests, and checks the IDL for drift.
3. Requires a byte-identical second clean build.
4. Runs the 42-case SDK/LiteSVM suite against that fresh binary.

Merge once CI is green.

## 2. Download the exact CI artifact

Use the **push** run on `main` for the merged commit, not a PR run. A PR run builds a synthetic merge commit, and the preflight rejects it.

```bash
gh run list -b main -w "OAR checks" -L 5
gh run download <RUN_ID> -n oar_registry-<COMMIT_SHA> -D ~/oar-artifact/<COMMIT_SHA>
```

The directory holds `oar_registry.so` and `build-metadata.json`: commit, program ID, builder digest, tool versions, SHA-256, executable hash, IDL hash, double-build result and run URL. It never contains a keypair.

## 3. Operator tools

- Node 24.19.0. In a clean checkout of that commit (or a later one with no program-source changes), run `npm ci --ignore-scripts && npm run build`.
- Agave CLI, a **stable** release (`solana --version`; rc/beta/alpha are refused). The builder used 4.1.2. Install a current stable tag from https://github.com/anza-xyz/agave/releases with `sh -c "$(curl -sSfL https://release.anza.xyz/<TAG>/install)"`.
- Optional but recommended: `cargo install solana-verify --version 0.5.2 --locked`. When present, deploy also cross-checks the onchain hash with it.

Set the shared values once:

```bash
K=~/.config/solana/oar
ART=~/oar-artifact/<COMMIT_SHA>
RPC=https://api.devnet.solana.com     # or a dedicated devnet RPC; only its host is ever recorded
ID=<PROGRAM_ID>
```

## 4. Preflight (read-only)

```bash
npm run devnet:preflight -- --artifact-dir $ART --program-keypair $K/$ID.json \
  --upgrade-authority $K/devnet-upgrade-authority.json --payer $K/devnet-payer.json --rpc $RPC
```

The preflight checks:

- the CLI is a stable release;
- the RPC is devnet;
- the working tree is clean;
- the artifact commit is in history, with no program-source change since then;
- the identity and secret scan passes;
- the artifact SHA-256, executable hash, builder digest, program ID and IDL hash all match the build metadata, and the double build matched;
- the three keys are distinct and the program keypair matches `declare_id!`;
- the onchain state is known: absent means `fresh`, and an existing program needs the expected authority;
- the payer has enough balance.

Expect `PREFLIGHT PASSED`, mode `fresh`, and roughly 2.5 SOL required for a ~175 KB binary.

## 5. Deploy

```bash
npm run devnet:deploy -- --artifact-dir $ART --program-keypair $K/$ID.json \
  --upgrade-authority $K/devnet-upgrade-authority.json --payer $K/devnet-payer.json --rpc $RPC --confirm $ID
```

The deploy script:

1. Re-runs the preflight.
2. Checks that the installed `solana program deploy --help` supports every flag it uses.
3. Deploys the exact artifact: `--use-rpc`, a priority fee, the upgrade authority as signer, and no `--final`.
4. Waits for the next slot.
5. Verifies the owner and upgrade authority.
6. Dumps the ProgramData and compares the onchain executable hash with the artifact, plus `solana-verify get-program-hash` when installed.
7. Records the public results in `release/devnet.json`.

**If it fails:**

- Keep the first error.
- Any buffer-recovery phrase is printed only to your terminal; never paste it anywhere.
- List partial buffers with `solana program show --buffers --buffer-authority <AUTHORITY_PUBKEY> -u $RPC`.
- Resume with `--buffer`, or close the buffer as a separate decision.
- Never generate a new program keypair to "retry".

## 6. Publish the IDL (Program Metadata, seed `idl`)

```bash
npm run devnet:idl -- --upgrade-authority $K/devnet-upgrade-authority.json --payer $K/devnet-payer.json --rpc $RPC --confirm $ID
```

This uses the lockfile-pinned `program-metadata` 0.10.0 CLI. It reads the IDL back and requires it to match `idl/oar_registry.json`.

## 7. Smoke suite

```bash
npm run devnet:smoke -- --payer $K/devnet-payer.json --rpc $RPC
```

The suite registers a throwaway App ID and drives it through every instruction with the real `oar` CLI. Expected outcomes:

- **Must succeed:** `register` → `update` → `propose-authority` → `accept-authority` → `deprecated` → `retired`.
- **Must fail with the exact error:** a duplicate nonce, an update by a non-authority, accept with nothing pending, accept by an unproposed key, an update by the previous authority, and an update after retirement.

Results, compute units, signatures and the final record state go to `release/evidence/devnet-smoke-<date>-<id>.json`. An ephemeral devnet key is created in the OS temp dir, its lamports are returned to the payer, and the key is deleted.

## 8. Record

When the hash, IDL and smoke checks have all passed, `release/devnet.json` shows `"status": "DEVNET_VERIFIED"`. Commit the following through a PR:

- `release/devnet.json`
- `release/gwap-release-record.devnet.json`
- `release/evidence/`

The GWAP record follows GWAP MASTER `schemas/release-record.schema.json`. Its JSON is valid YAML, so it can be appended to `registries/RELEASE_REGISTRY.yaml` as is.

## Optional: register OAR itself (end-to-end link proof)

1. Derive the App ID: `node packages/cli/dist/index.js app-id --creator <PAYER_PUBKEY> --nonce 0`.
2. Create the manifest: `oar init --app <APP_ID> -c devnet -o release/devnet/oar.manifest.json`.
3. Edit the manifest:
   - set `name` and `summary`;
   - set `categories` to `["infrastructure", "identity"]`;
   - set `programs` to `[{ "address": "<PROGRAM_ID>", "cluster": "solana:devnet", "name": "OAR Registry", "role": "registry" }]`;
   - set `repositories` to `[{ "url": "https://github.com/gwapupward-hub/oar", "role": "program" }]`;
   - remove the placeholder domain.

   Then run `oar validate`.
4. Commit it to `main`. Then register with the commit-pinned URI:
   `oar register -m release/devnet/oar.manifest.json --uri https://raw.githubusercontent.com/gwapupward-hub/oar/<COMMIT>/release/devnet/oar.manifest.json -k $K/devnet-payer.json -c devnet -u $RPC`.
5. Write the program backlink as the upgrade authority:
   `oar link-file --app <APP_ID> -c devnet -o /tmp/oar-link.json`, then
   `npx program-metadata write oar $ID /tmp/oar-link.json --format json -k $K/devnet-upgrade-authority.json -p $K/devnet-payer.json --rpc $RPC`.
6. Check the link: `oar resolve-program $ID -c devnet -u $RPC` must report `link verified`.

## Upgrades on devnet

Run the same sequence with a newer CI artifact. The preflight detects `upgrade` mode: the program keypair is not needed, the onchain upgrade authority must match, and it warns if the ProgramData must grow.

Each deployment moves the previous build, deployment, IDL and smoke evidence into `history`. The new artifact must re-earn its IDL and smoke evidence.

## Costs (175,064-byte binary)

| Item | SOL |
| --- | --- |
| ProgramData rent (kept) | ≈ 1.2196 |
| Program account rent (kept) | ≈ 0.0011 |
| Upload buffer (refunded when the deploy completes) | ≈ 1.2196 |
| Fees and margin | ≈ 0.05 |
| **Fund the payer with** | **≥ 3** |

## Stop conditions

Stop and report rather than improvise if any of these happen:

- the preflight fails;
- the onchain authority or program state is unexpected;
- the post-deploy hash differs;
- the IDL read-back differs;
- any smoke case fails;
- a keypair or recovery phrase was exposed.

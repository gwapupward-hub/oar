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

## 9. Register OAR itself (end-to-end link proof)

OAR's own App ID on devnet is `Bu1JCyxiVDdDGjtNLLkKhq6KZv6E4LcUgqNkS5t5Nf2K`. It is derived from the devnet fee payer `91N96Z…` with nonce 0. Its manifest (`release/devnet/oar.manifest.json`) claims the OAR program and this repository. `oar.json` at the repo root is the repository proof.

`npm run devnet:oar-app -- prepare` regenerates both files from `release/devnet.json`. Both files are already committed.

**Prerequisite:** the repository must be **public**. Wallets fetch the manifest and `oar.json` from raw.githubusercontent.com without credentials.

```bash
npm run devnet:oar-app -- publish --payer $K/devnet-payer.json \
  --upgrade-authority $K/devnet-upgrade-authority.json --rpc $RPC --confirm Bu1JCyxiVDdDGjtNLLkKhq6KZv6E4LcUgqNkS5t5Nf2K
```

Before any transaction, `publish` checks that:
- the RPC is devnet and the recorded deployment is verified;
- the payer derives the committed App ID;
- the upgrade authority matches the one on-chain;
- the commit-pinned manifest URL serves bytes with the committed hash (fetched through the SDK, the same transport wallets use);
- `oar.json` is served from the default branch.

Then it:
1. Registers the App ID. If an identical record already exists, it skips this step; a record with a different manifest stops the run.
2. Writes the program's canonical `oar` backlink, signed by the upgrade authority. A backlink that names something else stops the run.
3. Resolves the program as a wallet would. It requires `link verified`, manifest `ok`, status `Active`, and the program and repository claims both `verified`.

Evidence goes to `release/evidence/devnet-oar-app-<date>-<id>.json` and `oarApp` in `release/devnet.json`. The cost is about 0.004 SOL of record rent plus the metadata account rent.

## 10. SAS compatibility rehearsal

This rehearses issuer evidence against the real Solana Attestation Service on devnet. Create a dedicated **issuer** key and fund it with about 0.05 SOL:

```bash
solana-keygen new -o $K/devnet-sas-issuer.json
npm run devnet:sas -- --payer $K/devnet-payer.json --issuer $K/devnet-sas-issuer.json --rpc $RPC --confirm devnet
```

**Setup:**
- It creates a TEST credential `oar-devnet-rehearsal` and the `oar-domain`, `oar-repo` and `oar-program` schemas. Each schema is created as v1 (the legacy shape without cluster binding), then moved to v2 with the exact SDK layout.
- These steps are idempotent on re-runs.
- It registers a throwaway app that claims `example.com`, this repository and the devnet Memo program. The SDK reads that app's manifest through an injected fetch, and still checks it against the on-chain hash.

**What must hold** (every case is judged by the SDK):
- Each v2 schema matches the SDK layout.
- With no evidence, every claim is unverified.
- These are rejected:
  - a wrong subject or a wrong app cluster: `mismatch`;
  - domain method 2 or program method 1: `invalid`;
  - an expiry beyond the TTL, or a zero expiry: `invalid`, or SAS refuses it.
- v1 evidence is ignored. Mainnet program evidence does not count on devnet but is valid in its own context.
- Valid evidence is ignored from an untrusted issuer, and shows as `attested` from the trusted credential.
- Pausing a schema fails closed for its claims only; unpausing restores them.
- A revoked (closed) attestation drops back to unverified.

**Cleanup:** every rehearsal attestation is closed and its rent returned, and the throwaway app is retired. The credential and schemas remain as a documented TEST issuer.

Evidence goes to `release/evidence/devnet-sas-rehearsal-<date>-<credential>.json` and `sas` in `release/devnet.json`.

The scripts' expectations are also unit-tested offline (`npm run test:devnet`), using accounts built with the pinned `sas-lib` encoders.

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

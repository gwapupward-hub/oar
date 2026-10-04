<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logos/OAR_primary_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="brand/logos/OAR_primary_light.svg">
    <img alt="OAR — Open App Registry" src="brand/logos/OAR_primary_light.svg" width="560">
  </picture>
</p>

<p align="center"><strong>Open by default. Verifiable by design.</strong></p>
<p align="center"><a href="./BRANDING.md">OAR Brand System v1.0</a></p>

# Open App Registry (OAR)

Onchain application identity for Solana. Every app gets one permanent **App ID** that wallets, explorers and stores can resolve to its publisher, domains, programs and source, with every link proven from both sides instead of just claimed.

> Status: **0.1.1-rc.1. Devnet: deployed and verified (October 4, 2026); mainnet: NO-GO.** The CI-built binary is live on devnet. Its onchain executable hash matches the build, the published IDL matches the repo, and the 13-check smoke suite passed (`release/devnet.json`, `release/evidence/devnet-smoke-2026-10-04-oariw8YX.json`). OAR is registered on devnet as its own app, with the program link, manifest and repository all verified, and the SAS attestation rehearsal passed 21/21 with a TEST credential (`release/evidence/`). Governance, dependency and CI hardening, operations and independent review remain mainnet gates. See `docs/PRODUCTION-READINESS.md`.

- **Spec:** `docs/spec-v0.1.md` (updated implementation contract)
- **Program ID:** `oariw8YXcYJh9sa9VcmBU3ZCdo2WVGMYPsLjEuUxfrC`, deployed on devnet at slot 507319507 (ProgramData `BoDE8nY9kcmLqbZCQZW6gfjzTJhcDzU7FB1ZWmUqM72d`, executable hash `1ecc9309…e065ff`; see `release/devnet.json`). Not deployed on mainnet. The previous `oarWKQoXgxp69Vupf883Pr1PvN35rAyZJeFu8q4pae5` is an exposed reference ID, and source checks and the CLI block it.

## How it works

| Piece | What it is |
| --- | --- |
| `AppRecord` PDA | `["app", creator, nonce_le_u64]` under the OAR program. Its address is the App ID. Holds authority, status and the manifest URI + SHA-256. |
| Manifest | Offchain JSON (`schema/manifest-0.1.schema.json`), hashed over its RFC 8785 canonical form. Lists domains, programs, repositories. |
| Program backlink | Canonical [Program Metadata](https://github.com/solana-program/program-metadata) account, seed `oar`, written by the program's upgrade authority. |
| Domain proof | `https://<host>/.well-known/oar.json` (no redirects) or DNS TXT `_oar.<host>` = `oar=<cluster>:<App ID>` |
| Repo proof | `oar.json` at the repository root on the default branch |
| Attestations | Issuers record checks as [Solana Attestation Service](https://attest.solana.com) attestations under `oar-*` schemas |

A claim counts only when the other side points back to the same App ID and cluster.

## Repository layout

```
programs/oar-registry/   Anchor program (anchor-lang 1.2.0): 5 instructions, no close
idl/oar_registry.json    Anchor IDL (source for the generated TS client)
schema/                  JSON Schemas: manifest, well-known/repo proof, program backlink
examples/                Example manifest
packages/sdk/            @open-app-registry/sdk — resolve, verify, register (@solana/kit 8)
packages/cli/            @open-app-registry/cli — the `oar` command
scripts/                 Codama client generation, schema embedding
brand/                   OAR Brand System v1.0 assets, tokens and canonical copy
```

## Build and test

Client checks use Node 24.19.0 and npm 11.9.0. Release builds use the digest-pinned Anchor 1.2.0 builder in `release/devnet.json` (Agave 4.1.2, platform-tools v1.54). The SDK tests need a program binary: `npm run build:program` writes one to `target/deploy/`, or set `OAR_PROGRAM_BINARY` to a CI artifact.

```bash
npm ci --ignore-scripts
npm run build:program        # target/deploy/oar_registry.so
npm test                     # Rust unit tests + SDK tests (program runs in LiteSVM)
npm run build                # SDK and CLI to dist/
```

After changing the program or `/schema`:

```bash
npm run build:program
npm run idl          # tools/idlgen: builds the IDL with anchor-lang-idl, no Anchor CLI needed
npm run generate     # re-embeds /schema and regenerates the Codama client in packages/sdk/src/generated
npm test
```

`anchor idl build` produces the same IDL if you have Anchor CLI 1.x.

## CLI rehearsal (after fresh public identity selection and build)

```bash
alias oar="node packages/cli/dist/index.js"

oar app-id --creator $(solana address)            # derive your App ID
oar init --app <APP_ID> --cluster devnet          # write oar.manifest.json, then edit it
oar validate oar.manifest.json
# upload the manifest (Arweave/IPFS recommended), then:
oar register -m oar.manifest.json --uri ar://<TX_ID> --cluster devnet

oar well-known --app <APP_ID>                     # serve at https://<host>/.well-known/oar.json
oar link-file --app <APP_ID>                      # then run the printed program-metadata command as upgrade authority
oar inspect <APP_ID> --cluster devnet
oar resolve-program <PROGRAM_ID> --cluster devnet
```

`register` and `update` refuse a manifest whose `app_id` or `cluster` does not match the target record.

## SDK

```ts
import { createSolanaRpc, address } from '@solana/kit';
import { resolveProgram } from '@open-app-registry/sdk';

const rpc = createSolanaRpc('https://api.devnet.solana.com');
const r = await resolveProgram(rpc, address('<PROGRAM_ID>'), { cluster: 'solana:devnet' });
if (r?.link?.state === 'verified') console.log(`Program belongs to ${r.app.manifest.ok ? r.app.manifest.manifest.name : r.app.appId}`);
```

Wallets should show an app name for a program only when `link.state === 'verified'`.

## Security

The supplied keypair was exposed and has been removed from distribution. The reference ID is LOCAL-TEST-ONLY, and CLI writes at that ID are blocked. The historical binary built at that ID was removed; tests now run against a fresh source build. Select a fresh identity privately and pass only its public address to `node scripts/set-program-id.mjs <PUBLIC_ADDRESS>`. This changes all App IDs derived under the registry and requires regenerating manifests/backlinks. No production key or issuer credential is included. See `SECURITY.md`.

## License

Apache-2.0

## Hardened verification contract

Link schemas use version 2. `deriveAttestationNonce(schema, appId, subject, { appCluster, programCluster? })` requires cluster context; program claims require both clusters. Old version-1 attestations are not lifted into badges. The full onchain schema layout, field names, paused state, payload, nonce and expiry are checked. Domain methods 0/1 and program method 0 are supported. Evidence must expire within 30 days (domain/repo) or 90 days (program); zero-expiry evidence is rejected.

The default issuer list is empty. No issuer service, build/source/audit badge adapter, binary security metadata reader, or onchain deployment is included. The supported production scope is live bidirectional link verification, plus explicitly configured issuer evidence once SAS compatibility has been rehearsed.

Node HTTP uses a public-destination policy and pins validated DNS answers into each TLS connection. Every redirect is checked; one deadline bounds the complete fetch. Browser or custom transports must be explicitly injected and must enforce their own connection-time destination policy. Compressed backlinks use bounded Node decompression; unsupported browser decompression fails closed.

```bash
npm run build
npm run typecheck
npm run test:sdk       # needs target/deploy/oar_registry.so or OAR_PROGRAM_BINARY
npm run test:devnet    # devnet release-gate unit tests
npm run test:cli
npm run check:source
npm run check:production  # intentionally fails until external release evidence exists
python3 scripts/package-release.py /tmp/oar-candidate.zip
```

On every push and PR, CI runs these steps inside the pinned builder: rustfmt, clippy and Rust tests, the sBPF build, an IDL drift check and a byte-identical second build. The client job then runs the SDK suite against that exact binary, and the binary is uploaded with `build-metadata.json` for the devnet operator scripts (`scripts/devnet/`). No workflow deploys or receives signer material.

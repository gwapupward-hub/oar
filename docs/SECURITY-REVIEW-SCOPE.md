# OAR independent security review — scope packet

This is for the external reviewer who will clear the mainnet gate in `docs/PRODUCTION-READINESS.md`. The internal pre-review (`docs/reviews/2026-10-04-internal-prereview.md`) is context only. It is **not** independent and does not satisfy that gate.

## What is being reviewed

| Item | Pin |
| --- | --- |
| Program source | `programs/oar-registry/` at commit `9329e0d9b4f2a74efbc7d3e15612a9d83b30facc` (Anchor 1.2.0, 5 instructions, about 200 lines of Rust) |
| Deployed artifact (devnet) | `oariw8YXcYJh9sa9VcmBU3ZCdo2WVGMYPsLjEuUxfrC`, ProgramData `BoDE8nY9kcmLqbZCQZW6gfjzTJhcDzU7FB1ZWmUqM72d`, slot 507319507. Executable hash `1ecc93092bbd284e77dddb5b9318ac2c9ba6f4a9bedf0fafd45cdfebffe065ff` (`release/devnet.json`) |
| Builder | `quay.io/ottersec/anchor@sha256:54e9bbc858586177159b136ba757d52a84832f2fe98e64224a4e104f71cfbb4d` (Agave 4.1.2, platform-tools v1.54). CI requires two byte-identical clean builds |
| IDL | `idl/oar_registry.json`, SHA-256 `15ab0399…220057`, published on devnet through Program Metadata (seed `idl`) |
| SDK verifier | `packages/sdk/src/{attestations,links,resolve,manifest,http}.ts` at the head of the review branch |
| CLI signing path | `packages/cli/src/{tx,index}.ts` |
| Release and operator tooling | `scripts/check-release.mjs`, `scripts/package-release.py`, `scripts/release.mjs`, `scripts/devnet/*.mjs`, `.github/workflows/{ci,release}.yml`, `deny.toml` |
| Release candidate | `v0.1.1-rc.1` (GitHub pre-release). Its assets carry `SHA256SUMS`, `release-manifest.json` and the dependency reports |

The final mainnet source commit and artifact hash replace these pins when they are approved. The review must cover that exact commit and binary.

## Protocol invariants to verify

1. **App identity.** An App ID is the PDA `["app", creator, nonce_le_u64]` under the registry. Only the creator, as signer, can create it, so no one can squat a creator's IDs.
2. **Record authority.** Only `authority` can update the manifest, propose a transfer or change status. A transfer is two-step: the current authority proposes, and the proposed key accepts by signing. An all-zero proposal cancels.
3. **Retirement is terminal.** Retired records reject every instruction, and retirement clears any pending authority.
4. **Manifest binding.** The record commits to SHA-256 of the RFC 8785 canonical manifest. A manifest counts only if its hash, schema, `app_id` and `cluster` all match the record.
5. **Bidirectional links.** A program claim verifies only when the program's canonical Program Metadata account (seed `oar`, direct source, JSON, at most 16 KiB) names the same App ID and registry cluster. Domain and repository proofs must name the same App ID and cluster.
6. **Attestations.** Clients trust only an explicit credential list; the default is empty. A claim's attestation must match:
   - the derived address and nonce;
   - the v2 schema, including its layout, field names and unpaused state;
   - the payload: app, cluster and subject;
   - the method and the time bounds;
   - and its signer must still be authorized by the credential.
7. **Fail closed.** Malformed accounts, metadata, HTTP, DNS or attestation data never upgrade a claim's state.
8. **Network policy.** The default Node transport rejects non-public destinations at every hop, pins validated DNS answers, and bounds time, body size and decompression.

Trust boundaries and operational rules are in `docs/RELEASE-RUNBOOK.md` ("Protocol invariants and trust boundaries").

## Authorities

| Authority | Devnet today | Mainnet requirement |
| --- | --- | --- |
| Program upgrade (also canonical metadata writer) | Single devnet key `2iceQADt8dJwpRLqoszVTcnRVnPUfBFtKxMTuqvWoovr` | Squads multisig with an approved threshold; rehearsed on devnet first |
| Fee payer | `91N96ZPGHcFWe2jEZie9rUVqyHF5BWMV7mYnHMurhWB7` | Operational key, separate from the upgrade authority |
| Program ID key | Offline; signs only the first deploy per cluster | Same ID, kept offline |
| AppRecord authority | Per app (user-chosen) | n/a |
| SAS issuer credentials | TEST credential `oar-devnet-rehearsal` only | Explicit client configuration; none by default |

## Prior findings already fixed (do not re-report without new evidence)

These are OAR-01 to OAR-06 in `docs/PRODUCTION-READINESS.md`:
- the exposed program identity, now rotated;
- cluster reuse in program attestations, now cluster-bound;
- incomplete SAS payload and schema validation;
- the hosted-fetch destination policy;
- decoder failure isolation;
- spec mismatches.

The internal pre-review adds:
- OAR-IR-01: attestation signers are re-checked against the credential's current signers.
- OAR-IR-02: duplicate JSON keys are rejected.
- OAR-IR-04: CI actions are pinned and the dependencies are scanned.

## How to reproduce and verify

```bash
git checkout <commit>
docker run --rm -v "$PWD:/work" -w /work <builder digest> cargo build-sbf --manifest-path programs/oar-registry/Cargo.toml -- --locked
sha256sum target/deploy/oar_registry.so                       # compare with release/devnet.json build.artifact_sha256
solana-verify get-program-hash -u devnet oariw8YXcYJh9sa9VcmBU3ZCdo2WVGMYPsLjEuUxfrC   # equals build.executable_hash
npm ci --ignore-scripts && npm run build
OAR_PROGRAM_BINARY=target/deploy/oar_registry.so npm run test:sdk   # LiteSVM suite against the fresh binary
cargo test --locked -p oar-registry --lib && npm run test:cli && npm run test:devnet
```

Live devnet evidence:
- `release/evidence/devnet-smoke-2026-10-04-oariw8YX.json`: lifecycle and negative cases, with signatures.
- `release/evidence/devnet-oar-app-2026-10-04-Bu1JCyxi.json` and `release/evidence/devnet-sas-rehearsal-2026-10-04-GFHnocWS.json`: self-registration and the SAS rehearsal.

## Requested depth

- **Program:** account validation (owner, discriminator, PDA and bump, signer, `has_one`), the authority state machine, rent and size, arithmetic, Anchor 1.2.0 code generation, and upgrade-path risks.
- **SDK:** every path that can produce `verified` or `attested`. That includes RPC and decoder trust, Program Metadata parsing and decompression, HTTP/DNS rebinding and redirect handling, RFC 8785 hashing and JSON parsing differences, and time handling.
- **Supply chain:** the npm and Cargo lockfiles, the builder image, and CI workflow permissions.
- **Deliverable:** for each finding, give severity, evidence, exploit path, remediation and a regression test, then a GO, GO WITH CONTROLS or NO-GO verdict for mainnet.

## Out of scope

- Live-only SAS issuer operations (no issuer service ships).
- Build, source and audit badge adapters (planned and disabled).
- The binary security metadata reader.
- Wallet UI rendering beyond the display rules in the spec.
- Third-party programs: SAS, Program Metadata and the loaders. Their integration points are in scope.

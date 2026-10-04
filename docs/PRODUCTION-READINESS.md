# OAR production-hardening result — October 3, 2026

**Verdict: GO for continued local engineering; NO-GO for production deployment.** The demonstrated verifier and fetch-boundary defects are repaired in source and covered by regressions. A hardened candidate is delivered; a production deployment has not been proven or authorized.

## Implemented changes

| Review finding | Change | Evidence / residual requirement |
| --- | --- | --- |
| OAR-01, exposed identity | Keypair excluded from extraction/distribution; historical binary moved to a labelled fixture; CLI refuses writes at the disclosed ID; public-only identity synchronization and archive scan added | Archive scanned; fresh private release identity still required |
| OAR-02, cluster reuse | Program attestation v2 binds registry cluster and program cluster in payload and domain-separated nonce | Same-address devnet/mainnet regressions, including legitimate independently issued cross-cluster evidence |
| OAR-03, incomplete payload validation | Bounded account/schema decoding; actual layout/field names/pause/version checked; exact subject, ID, nonce, method and timestamp/expiry checked | Wrong host/repo/program/app/cluster/schema/nonce, short data, trailing data and time regressions |
| OAR-04, hosted fetch policy | Node transport rejects private/special-use literal and DNS answers, pins validated destination at TLS connect, checks redirects and caps total time/body size | Literal/alternate IPs, mixed DNS answers, pinned-lookup test, stalled headers/body/DNS and oversized body regressions; custom adapters remain trusted |
| OAR-05, decoder failures | Owner/discriminator/allocation/layout/status/PDA/bump checks precede accepted AppRecord resolution; metadata and issuer failures fail closed per claim | Malformed record/metadata and isolated issuer-failure regressions |
| OAR-06, spec mismatch | Actions exact-host rule; strict minor-version policy; empty default trust; unimplemented adapters/issuer operations marked planned | Spec updated; production scope explicitly constrained |
| Additional hardening | Exact repository roots; metadata seed/encoding/format/size checks; capped decompression; release/CI checks | Repository-path and compressed-backlink-bomb regressions |

No functional onchain instruction or account-layout change was made. Anchor/security-txt dependencies were constrained to the already locked exact versions. JS candidate version is 0.1.1-rc.1; manifest remains 0.1, AppRecord layout remains 1, supported link schemas become 2. This is a breaking attestation/nonce API change for prototype issuers: reprovision/reissue v2 evidence, and do not reinterpret v1 evidence.

## Local verification

- SDK/LiteSVM: **42 passed**, zero failed/skipped.
- CLI release-identity guard: **1 passed**, zero failed/skipped.
- SDK/CLI build and typechecks passed.
- Schema/client generation ran successfully; generated client output matches the input IDL/client files.
- Identity/source and actual ZIP signer-exclusion checks passed.
- JavaScript `npm audit --json --fetch-retries=0 --fetch-timeout=10000` returned zero reported vulnerabilities. This is an advisory-database check, not an external code audit. Rust dependency review remains missing.
- Production gate intentionally returns nonzero because identity/build/review/rehearsal/governance/operations evidence is missing.

Instruction simulations use the HISTORICAL supplied binary, SHA-256 `90026a6b69acff7027d21676cc5000b524d9f141aa0b4f7747ff62c97a607458`. These tests validate the changed SDK against that artifact. They do not establish fresh Rust source-to-binary equivalence. Rust, Cargo, Solana/Agave, Anchor and Docker executables are unavailable in this workspace; no Rust units, fresh sBPF build, CI run, independent reproducibility comparison, local-validator or devnet rehearsal ran here. The release builder digest and exact Rust/platform-tools pins remain unset rather than invented.

## Devnet preparation — October 4, 2026

- Two Rust release-gate blockers were fixed:
  - `cargo fmt --check` failed on the `validate.rs` tests.
  - `Cargo.lock` held `solana-security-txt` 1.1.3 against the `=1.1.1` pin, so every `--locked` build failed.
- The builder is pinned to `quay.io/ottersec/anchor@sha256:54e9bbc858586177159b136ba757d52a84832f2fe98e64224a4e104f71cfbb4d` (tag v1.2.0). It contains anchor-cli 1.2.0, Agave 4.1.2, cargo-build-sbf 4.1.0, platform-tools v1.54 and rustc 1.98.1. The program builds from source with it.
- CI now builds the program on every push and PR, requires a byte-identical second build, and runs the SDK suite against that binary. The historical fixture was removed.
- Guarded operator scripts (`scripts/devnet/`) and `docs/DEVNET-DEPLOY.md` cover:
  - a read-only preflight;
  - deploying the exact CI artifact, with the onchain hash compared afterwards;
  - publishing the IDL through Program Metadata and reading it back;
  - a 13-case smoke suite.
- Status: fresh program identity `oariw8YXcYJh9sa9VcmBU3ZCdo2WVGMYPsLjEuUxfrC` set (public address only; the keypair stays with the release custodian). Devnet deployment waits on the operator run. Mainnet remains NO-GO on the gates below.

## Remaining deployment blockers and owners

| Gate | Owner | Acceptance evidence |
| --- | --- | --- |
| Fresh release identity | Founder/release custodian | Approved fresh public program ID; private signer custody; all IDs reconciled and fresh binary rebuilt |
| Controlled build and Rust validation | Release engineer with builder access | Approved immutable image/tool versions; Rust tests/format/clippy; IDL drift check; fresh-binary tests and independent reproducibility hashes |
| SAS/dependency compatibility | Integration engineer | Actual intended devnet SAS schema/credential/issuance/pause/revocation evidence; Program Metadata and cross-cluster rehearsal |
| Independent security review | External reviewer | Review of final source, compiled artifact, network policy and authority paths; no unresolved material findings |
| Governance and operations | Founder/operations owner | Onchain authority verified, approved multisig policy, dedicated RPC configuration, monitoring/incident contacts and rollback rehearsal |
| Mainnet release authorization | Founder | Exact cluster/program/artifact/payer/authority/cost/recovery action separately approved immediately before broadcast |

Reference issuer worker, OtterSec build/source badge adapter and binary-security reader are still absent. They are excluded from the narrowed first-release scope and clearly marked planned. If the intended launch includes them, implementation and operational acceptance must be added before GO. An empty trust list remains the default.

## Reviewable handoff

Use `docs/RELEASE-RUNBOOK.md` in order. Import source into the intended repository, select a fresh public identity privately, configure the approved immutable builder and run `fresh-program` CI. Then complete dependency rehearsal and independent review. No new signer was generated or used, and no live program or authority was changed.

The updated ZIP replaces the original source package; this report records the hardening pass separately. Original input ZIP SHA-256: `a5e01b997350959e8afa94ddb0a65937e738aeb6101f2cf2848da8462b3b37b8`. `docs/ARCHIVE-SOURCE-MANIFEST.json` preserves the prior hardened archive source fingerprints; it is not an upstream Git commit or signature.

## Primary references checked

- Anchor verifiable-build documentation: https://www.anchor-lang.com/docs/references/verifiable-builds (checked October 3, 2026). The documented container workflow informs the runbook; no verifiable build was executed here.
- SAS upstream guidance: https://github.com/solana-foundation/solana-attestation-service/blob/master/CLAUDE.md (checked October 3, 2026). Current vector-code differences remain relevant to unsupported audit/build placeholders; scalar v2 fixtures use the pinned client. Attempts to fetch exact upstream source files were unavailable in the browsing service, so live dependency compatibility remains explicitly unproven.

Repository import: source/project/security links now point to `gwapupward-hub/oar`. The repository was empty before this import. CI/release evidence must be tied to the resulting Git commit. The prior archive fingerprint manifest is historical and will not match files whose repository links changed.

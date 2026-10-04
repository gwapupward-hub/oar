# OAR release runbook

Status: source hardening candidate, not deployment authorization. No signer material belongs in this repository, ZIP, ordinary CI secrets, build logs or reports.

## Protocol invariants and trust boundaries

App identity is the registry PDA (`app`, creator, u64 nonce) and its registry cluster. Creator pays rent; stored authority governs updates. Transfer requires proposal by the current authority and acceptance by the proposed signer. Retirement is terminal. This registry holds account rent only and has no escrow/token custody, withdrawals or account close path.

A manifest hash commits to canonical bytes. Its App ID and cluster must match the record. A program claim is `(address, program cluster)`; a program backlink names `(App ID, registry cluster)`. A domain/repository claim is the exact declared subject and registry identity. A publisher declaration is not an ownership proof.

SAS ownership/issuance is trusted for credential authorization; OAR independently validates schema, payload, identity, method and time. Issuer credentials are explicit client policy. No default issuer is provisioned. RPC providers are trusted to serve the selected finalized cluster; the SDK cannot independently verify a dishonest RPC. Caller-supplied cluster/RPC mappings must be reconciled against genesis hashes in deployment/integration configuration.

HTTPS, DNS and metadata bytes are untrusted. Default Node transport validates all DNS answers, pins the chosen address into TLS and disables connection pooling across requests. Custom transports are trusted adapters; they must preserve certificate validation and enforce the same egress policy. Outbound network firewalls remain an operational control. Compressed backlink output is capped at 16 KiB.

## Preparation without secrets

1. Place source in the intended Git repository and review the exact commit. Protect release branches and workflow changes. Preserve this archive's source hashes; the original archive has no upstream Git history.
2. Privately create/approve a fresh program identity using the release team's custody process. Keep its program-address signer separate from deployer and upgrade authority. Never reuse the reference identity.
3. Pass ONLY the approved public address to `node scripts/set-program-id.mjs <PUBLIC_ADDRESS>`. Source, Anchor config, IDL and generated client are synchronized. Update app manifests/backlinks for the newly derived App IDs. Rebuild everything; the old test binary is unusable after identity changes.
4. The approved Anchor 1.2.0 builder is pinned by digest in `release/devnet.json`, with its recorded tool versions. For mainnet, set `release/production.json` to the same digest and the source commit. Toolchain compatibility must be demonstrated, not inferred from a tag.
5. The `program` CI job runs on every push and PR. It covers Rust tests, format and clippy, the sBPF build and the IDL comparison, and requires two clean builds to be byte-identical. The `client` job runs the SDK suite with `OAR_PROGRAM_BINARY` pointing to that output. Retain the uploaded artifact (`oar_registry.so` and `build-metadata.json` with the SHA-256 and executable hash) for the commit being released. Run a separate controlled builder for independent reproducibility evidence where practical.
6. Review advisory/license results for both JS and Rust dependency graphs. The local JS audit returned zero reported advisories; Rust advisory checks have not run. Pin workflow actions to reviewed immutable commits before production CI use.

## Supported first-release scope

Supported code: five registry instructions; manifest/proof validation; live bidirectional program/domain/repository links; version-2 issuer evidence with explicitly configured credentials. Exact manifest version 0.1 is supported; extensions are namespaced.

Excluded from first-release acceptance: build/source/audit chips; immutable-program issuer assertions; default issuer worker/recheck/revocation operations; extraction of binary security metadata. Reserved constants/schema drafts do not imply functionality. If any excluded capability is advertised as live, its implementation, tests and operations become mandatory release blockers. A registry-only release can use live checks without enabling issuer attestations.

SAS gate: provision TEST credentials and version-2 schemas on the intended devnet SAS release, issue correct and deliberately mismatched evidence, verify accepted methods/field encoding/expiry, pause a schema and close/revoke evidence, and re-resolve. The pinned `sas-lib@1.0.10` fixtures establish wire-format compatibility locally only. Audit/build vector codes remain unresolved and unsupported. Capture actual credential/schema addresses and transaction signatures; never substitute local fixtures for this evidence.

## Devnet rehearsal and security acceptance

The devnet deploy, IDL publication and smoke suite are scripted and gated in `docs/DEVNET-DEPLOY.md`. Evidence is recorded in `release/devnet.json` and `release/evidence/`.

Use an explicitly approved devnet program ID, artifact SHA-256, fee payer, upgrade governance path and RPC/genesis. No live mutation is authorized merely by access to a signer. Rehearse register/update/transfer cancellation/acceptance/deprecation/retirement, wrong signers, invalid inputs and repeated operations. Exercise canonical Program Metadata, both domain proofs, exact repository roots, expiry/revocation, malformed dependencies and cross-cluster claims. Measure compute, transaction size and account rent for actual paths. Capture actual signatures and slots.

A separate reviewer must trace registry authorities, every badge acceptance path, metadata/decompression, DNS/HTTP adapters and release packaging. Review the fresh binary/source relationship. Resolve material findings before rollout. Obtain test coverage for unexpected loader/program state and integrated RPC behavior rather than assuming local fixtures represent deployed dependency programs.

## Operations and rollback

Provide a dedicated RPC and independent fallback for each configured cluster. Never change clusters on failure. Resolve with finalized account evidence; compare current cluster/genesis and record slots during reconciliation. Bound requests and retries at the service level; apply request/concurrency limits to permissionless lookups.

Log structured app/cluster/claim/result/time context without URL credentials, signer bytes or RPC tokens. Alert on RPC failures/slot lag, manifest failures, dependency parser failures, false-badge reports and issuer expiry/revocation lag. Assign an actual operations owner and escalation contact before launch.

The registry has no emergency pause instruction. Service containment is disabling affected badge/issuer rendering or the integration; onchain code changes require the approved upgrade authority. An incident must not silently mark stale evidence verified. Retain the previous compatible binary and hash; rollback is another explicitly approved upgrade, never an automatic action. No account-layout migration is introduced by this hardening pass, but a fresh program ID does not preserve old App IDs. Rehearse SDK rollback and cache invalidation for v2 evidence.

A managed issuer service, if later enabled, needs its own narrow signer/custody, finalized issuance confirmation, retries/idempotency, recheck schedule shorter than expiry, revocation rules, monitoring, incident owner and durable evidence store. These are not delivered by this SDK.

## Production gate and release record

`npm run check:production` verifies identity and the presence of configured evidence files. It is a mechanical inventory check, not proof that submitted evidence is genuine or adequate. Reviewers must inspect the actual logs, signatures, artifact hashes and governance approvals. Blank evidence remains intentionally blocking.

Record: cluster/genesis and RPC class; source commit; immutable builder digest and tool versions; program ID/ProgramData/loader; artifact and IDL hashes; current/new deployment slot; upgrade authority before/after; fee payer public key; proposal and transaction signatures; security/rehearsal/resource results; monitoring owner; rollback artifact; approvers and residual risks.

Before any mainnet deployment/upgrade or authority mutation, present the exact target, action, artifact hash, payer, authority, estimated cost and recovery path for distinct final authorization. No deployment workflow is included; no live mutations were performed during this hardening pass.

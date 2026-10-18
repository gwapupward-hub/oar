# OAR App Standard v0.1 — developer integration contract

**Status:** experimental developer tooling on Solana Devnet. The OAR registry
program, manifest version and account layout are unchanged. This document
specifies an opt-in app development convention, **not** a Solana Foundation
standard or a claim of Metaplex affiliation.

## 1. Goal

An OAR-ready application starts with an identity integration from project
creation, not a post-launch manual checklist. OAR offers an App ID, a
hash-committed manifest, and independent bidirectional proofs connecting the
application to its website, repository, and deployed programs.

This standard is permissionless. Developers can implement it without using
OAR-hosted infrastructure or requesting approval from GWAP. App ID
registration is not security verification, accreditation, or endorsement.

## 2. Compatibility

- **App Standard:** 0.1. This is a developer-workflow contract and does not
  introduce an onchain account or instruction.
- **OAR manifest:** existing 0.1 schema in `schema/manifest-0.1.schema.json`.
- **OAR SDK:** existing `@open-app-registry/sdk` / `sdk/register` entry points.
- **OAR registry:** existing five-instruction program and AppRecord PDA.
- **Initial network:** Solana Devnet only. Mainnet remains NO-GO.
- **Initial template:** Next.js; add Anchor, Solana Kit and other adapters
  only after a complete end-to-end test of each.

This standard MUST NOT modify program IDs, derivation seeds, cluster binding,
the onchain record, or the existing fail-closed verification rules.

## 3. Project lifecycle

1. **Scaffold (no wallet):** create a project, config and frontend.
2. **Build:** write app code, deploy Solana programs if any, provision domain.
3. **Prepare (public key only):** derive `App ID = PDA("app", creator, nonce_le_u64)`;
   use the canonical OAR SDK to build and validate the manifest and proof files.
   The creator MUST inspect occupied nonces before attempting registration.
4. **Publish proofs:** serve the manifest and domain proof, and commit
   `oar.json` at the root of each listed repository. The proof must contain
   the App ID and the correct cluster. Manifest bytes are committed by
   SHA-256 over RFC 8785 canonical JSON.
5. **Register (owner approval):** use the creator wallet to sign an OAR
   `register` instruction. Registration MUST NOT happen during project
   scaffolding or simply by running `npm install`.
6. **Link programs (upgrade authority approval):** the actual deployed
   program's upgrade authority creates/updates the canonical Program
   Metadata `oar` backlink, or signs through a multisig.
7. **Resolve:** clients call the OAR verifier, which presents states for
   each claim: verified, attested, unverified, failed. The frontend MUST NOT
   synthesize a verified status from a config or registry record alone.

Deploying an OAR-ready frontend **does not** register an App ID. Immutable
programs and programs without an upgrade authority cannot publish a
canonical backlink and need a separately reviewed issuer process; do not
claim that support is shipped.

## 4. OAR project config (tooling only)

```json
{
  "standard": "0.1",
  "cluster": "solana:devnet",
  "name": "Example",
  "summary": "",
  "category": "other",
  "domain": "example.com",
  "repositories": ["https://github.com/example/app"],
  "programs": [],
  "nonce": 0
}
```

The config is developer input, NOT the signed onchain manifest. Tooling
MUST feed this into the existing SDK `buildClaimFiles`, `findAppId`,
`validateManifest` and `hashManifestHex`; the output manifest is
normative for the registry. An optional `manifestUri` allows immutable
Arweave/IPFS or other supported hosting. For an HTTPS domain the default
manifest lives at `/.well-known/oar-manifest.json`, while
`/.well-known/oar.json` is exclusively the domain proof.
`oar.json` at a repository root is exclusively a repository proof.

An app may have zero programs, and it may remain without a public domain
during local development. Preparation requires either a domain or a
supported manifest URI. Public key material is all the generator needs;
signer secrets MUST NOT enter the config, repo, CI or OAR service.

## 5. Reference CLI and template

The standalone `packages/create-oar-dapp` implements the v0.1 Next.js
reference:

```bash
node packages/create-oar-dapp/bin/create-oar-dapp.mjs my-app \
  --name "My App" --domain myapp.xyz \
  --repo https://github.com/me/my-app
cd my-app
npm install
npm run dev
npm run oar:prepare -- --creator YOUR_PUBLIC_SOLANA_WALLET
```

The generator never overwrites an existing directory. The preparation
script checks the manifest via the SDK and writes files only after
validation. Existing files require explicit `--force` to update. It
never reads private keys or broadcasts transactions.

The Next.js starter uses the published, fixed OAR SDK release candidate
tarball. We do not claim this prototype package is published to npm.
Further package publication and a `create-solana-dapp` community template
integration require separate testing and approval.

## 6. Security and compatibility invariants

- Only the creator signs creation; program metadata linking requires the
  actual program upgrade authority; record update needs its authority.
- OAR's registration transaction allowlist remains unchanged.
- No unchecked remote URL fetches, token custody, private-key prompts,
  or automatic external transactions are introduced by scaffolding.
- An app's displayed name is metadata, not a globally exclusive name.
- An OAR-ready label MUST NOT be displayed as a verified ownership badge.
- Invalid/absent claims fail closed in the existing SDK.
- Cluster and App ID must agree across record, manifest and proof.
- Source program code and the production release evidence remain independent
  gates; these tooling changes cannot waive mainnet NO-GO.
- Do not advertise future issuer/build/source/audit badges as implemented.

## 7. Acceptance and roadmap

**v0.1 acceptance:** a generated Next.js project boots, an existing OAR
SDK release prepares a valid manifest/domain/repo proof for a public
creator, invalid inputs fail without producing misleading files,
registration remains a separate user-controlled Devnet action, and
CI exercises the generator and preparation path.

**Adapter integration (follow-on to v0.1):** generated projects include
`src/lib/oar.ts`, a server-only @solana/kit resolver that accepts a program
address and returns its identity only when the existing OAR SDK reports the
program backlink as verified. No aggregate security label is inferred. A
read-only Anchor.toml adapter can preview and optionally import
`[programs.devnet]` public addresses into the developer config. It neither
tests onchain existence nor signs the canonical backlink. These adapters are
not a full Anchor Rust project generator or an onchain upgrade.

**Future work, not v0.1 claims:** interactive wallet registration from
the starter; deployment wizard integrations; official Anchor and Solana Kit
scaffolds; reusable GitHub Action; production npm publication; community
template distribution; verifier/discovery adapters for wallets.

Adoption metrics should count independently verified app registrations,
distinct integrating repositories, and third-party resolvers. Do not
count generated folders or unverified claims as adoption.

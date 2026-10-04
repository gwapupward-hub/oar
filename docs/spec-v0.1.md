> Implementation update — October 3, 2026: this document describes the 0.1.1-rc.1 hardening candidate. Manifest/account versions remain 0.1/1; supported SAS link schemas are version 2. Mainnet readiness remains NO-GO pending the release evidence in the accompanying report. Build/source/audit badges and the reference issuer service are planned, not implemented.

# Open App Registry (OAR) — Spec v0.1 Draft

Oct 3, 2026 · @Tha Gwap Spot 📍

## Summary

OAR gives every Solana application one permanent onchain App ID that wallets, explorers and stores resolve to its publisher, domains, programs and source. Each link is proven from both sides, not just claimed.

- **Problem:** Solana can say which program an instruction calls. It cannot say which application that program belongs to, who publishes it, or whether the site asking for a signature really is that app.
- **Approach:** a five-instruction registry program stores the App ID and a hash of its manifest. Everything else reuses existing primitives: Program Metadata for program backlinks, Solana Attestation Service (SAS) for verification badges, OtterSec verified builds for source.
- **Status:** draft v0.1. A reference implementation (program, TypeScript SDK, CLI) is built and passes its tests locally; nothing is deployed to devnet or mainnet yet. Program ID: `oariw8YXcYJh9sa9VcmBU3ZCdo2WVGMYPsLjEuUxfrC` (devnet deployment pending).
- **Name:** Open App Registry (OAR) is a working name. "SAS" was rejected because Solana Attestation Service already uses it, and this spec depends on that service. Renaming touches four constants: the Program Metadata seed `oar`, the `/.well-known/oar.json` path, the `_oar` DNS label and the `oar-` SAS schema prefix.

## Design principles and scope

OAR builds one small program and reuses existing standards for everything else. It is an identity layer, not a store and not a safety rating.

| Concern | Mechanism | Built by OAR |
| --- | --- | --- |
| App identity and manifest commitment | OAR registry program (`AppRecord` PDA) | Yes |
| Program to app backlink | [Program Metadata](https://github.com/solana-program/program-metadata) canonical account, seed `oar` | No, reused |
| Verification badges | [Solana Attestation Service](https://solana.com/news/solana-attestation-service), `oar-*` schemas | Schemas only |
| Binary matches source | [OtterSec verified builds](https://solana.com/docs/programs/verified-builds) | No, reused |
| Security contact | `solana-security-txt` in the program binary, plus manifest fields | No, reused |
| What a transaction does | [Clear Sign, sRFC 39](https://github.com/solana-foundation/SRFCs/discussions/4) | Out of scope |
| Mobile listing | Solana Mobile App NFT, referenced by mint | No, referenced |
| AI agent identity | [Solana Agent Registry](https://solana.com/agent-registry), referenced by ID | No, referenced |

Principles:

1. The App ID is the identity. The name is untrusted metadata, like a token's symbol.
2. Every link is bidirectional. The manifest makes a claim; the other side confirms it.
3. Registration is permissionless. Trust is a client decision about which attestation issuers to accept.
4. An app has 0 to N programs. Owning a program is not required.
5. The onchain footprint stays minimal. The manifest lives offchain, committed by hash.
6. Registry is not store. OAR asserts relationships, never safety or quality.

Non-goals for v0.1: ranking or curation, globally unique names, transaction decoding, reputation scores, token gating.

&#91;embedded content: OAR link model · 3 link proofs, issuers, clients\]

Solid arrows are claims the manifest makes; dashed arrows are backlinks the other side publishes. Issuers check both, and clients read the record, the backlinks and the attestations.

## Terminology

The key words MUST, SHOULD and MAY are used as defined in RFC 2119 and RFC 8174.

| Term | Meaning |
| --- | --- |
| App ID | Address of an `AppRecord` PDA. Permanent; never reused. |
| AppRecord | The onchain account: authority, status, manifest URI and manifest hash. |
| Manifest | Offchain JSON describing the app. Committed by SHA-256 over its RFC 8785 canonical form. |
| Creator | Signer and payer of `register`. Part of the PDA seeds; never changes. |
| Authority | Key allowed to update the record. Rotatable; a Squads vault is recommended. |
| Claim | A statement in the manifest: a domain, program, repository or platform listing. |
| Link proof | Confirmation of a claim from the other side: a Program Metadata backlink, a well-known file, a repo file, a DNS record. |
| Issuer | A SAS credential that checks link proofs and writes attestations. |
| Cluster | A Wallet Standard chain ID: `solana:mainnet`, `solana:devnet` or `solana:testnet`. |

## AppRecord account

Each app is one 427-byte `AppRecord` PDA, rent-exempt at about 0.0039 SOL, allocated at full size on creation so updates never reallocate.

**PDA derivation**

```text
App ID = find_program_address(["app", creator, nonce.to_le_bytes()], OAR_PROGRAM_ID)
```

- `creator` in the seeds blocks squatting and front-running: nobody else can derive your address.
- The App ID stays fixed when `authority` rotates, because the seeds use the creator, not the authority.
- `nonce` (u64) lets one creator register many apps: 0, 1, 2, and so on.
- Clients MUST check the account owner is the OAR program and the 8-byte discriminator is `sha256("account:AppRecord")[0..8]`.

**Layout** (Borsh, little-endian; fixed fields first so indexers can filter at fixed offsets)

| Offset | Size | Field | Type | Notes |
| --- | --- | --- | --- | --- |
| 0 | 8 | discriminator | `[u8; 8]` | Anchor account discriminator |
| 8 | 1 | layout\_version | `u8` | `1` for this spec |
| 9 | 1 | bump | `u8` | PDA bump |
| 10 | 1 | status | `u8` | 0 Active, 1 Deprecated, 2 Retired |
| 11 | 32 | creator | `Pubkey` | memcmp filter: apps by creator |
| 43 | 8 | nonce | `u64` | PDA seed |
| 51 | 32 | authority | `Pubkey` | memcmp filter: apps by authority |
| 83 | 32 | pending\_authority | `Pubkey` | All zeros means none |
| 115 | 32 | manifest\_hash | `[u8; 32]` | SHA-256 of canonical manifest; never all zeros |
| 147 | 4 | revision | `u32` | 0 at register, +1 per manifest update |
| 151 | 8 | created\_slot | `u64` |  |
| 159 | 8 | updated\_slot | `u64` | Last change of any kind |
| 167 | 4 + n | manifest\_uri | `String` | n is 1 to 256 bytes of printable ASCII |

**Status**

- **Active:** normal.
- **Deprecated:** still valid and updatable; clients show it as sunsetting.
- **Retired:** terminal. The record is frozen forever, any pending authority is cleared, and clients show no badges. This lets a team close an app, or neutralise a record whose links they are moving elsewhere.

## Instructions, events and errors

The program has five instructions and no close instruction, so an App ID can never be recreated or reused.

| Instruction | Signer | Arguments | Effect | Rejected when |
| --- | --- | --- | --- | --- |
| `register` | creator (pays rent) | `nonce: u64`, `authority: Pubkey`, `manifest_uri: String`, `manifest_hash: [u8; 32]` | Creates the record. Status Active, revision 0. | URI invalid, hash all zeros, authority all zeros, PDA already exists |
| `update_manifest` | authority | `manifest_uri`, `manifest_hash` | Replaces both; revision +1 | Not authority, Retired, URI or hash invalid |
| `propose_authority` | authority | `new_authority: Pubkey` | Sets `pending_authority`; all zeros cancels | Not authority, Retired, new equals current |
| `accept_authority` | pending authority | none | Moves pending into `authority`; clears pending | Signer is not the pending key, nothing pending, Retired |
| `set_status` | authority | `status: u8` | Changes status; Retired also clears pending | Not authority, already Retired, value above 2 |

URI rule: 1 to 256 bytes, each byte printable ASCII (0x21 to 0x7E), so no spaces or control characters. Allowed schemes are a client rule (see Manifest), not checked onchain.

Authority transfer is two-step so a typo cannot hand the app to an unowned key. Setting `authority` to a Squads vault at `register` is the recommended setup.

**Events** (Anchor `emit!`; indexers MUST treat account state as the source of truth, because logs can be truncated)

- `AppRegistered { app, creator, authority, manifest_hash }`
- `ManifestUpdated { app, revision, manifest_hash }`
- `AuthorityProposed { app, pending_authority }`
- `AuthorityAccepted { app, previous, authority }`
- `StatusChanged { app, previous, status }`

**Errors:** `UriEmpty`, `UriTooLong`, `UriInvalidChar`, `ZeroManifestHash`, `ZeroAuthority`, `Unauthorized`, `NoPendingAuthority`, `SameAuthority`, `AppRetired`, `InvalidStatus`, `RevisionOverflow`.

## Manifest

The manifest is a JSON document whose SHA-256, taken over its RFC 8785 canonical form, is stored in `manifest_hash`. A manifest that fails any validity rule is shown as unavailable, never partly trusted.

**Fields** (the normative JSON Schema is `schema/manifest-0.1.schema.json` in the reference repo)

| Field | Required | Rule |
| --- | --- | --- |
| `oar` | Yes | Spec version, `"0.1"` |
| `app_id` | Yes | Base58 App ID; MUST equal the record's address |
| `cluster` | Yes | Cluster where the record lives; MUST match where it was read |
| `name` | Yes | 1 to 64 characters, plain text |
| `summary` | No | Up to 140 characters |
| `description` | No | Up to 4,000 characters, plain text, never rendered as HTML |
| `icon` | No | `{ uri, sha256, media_type }`; PNG, JPEG or WebP only |
| `publisher` | No | `{ name, url }` |
| `categories` | Yes | 1 to 3 values from the category list below |
| `domains` | No | Up to 10 exact hostnames, lowercase, punycode for IDNs |
| `links` | No | `website`, `docs`, `support`, `x`, `discord`, `telegram`, `github`; all `https://` |
| `repositories` | No | Up to 10 `{ url, role }`, role is `app`, `program`, `sdk` or `other` |
| `programs` | No | Up to 32 `{ address, cluster, name, role }` |
| `platforms` | No | `web { url }`, `android { package, dapp_store_app }`, `ios { app_store_url }` |
| `interfaces` | No | `wallet-standard`, `mobile-wallet-adapter`, `solana-actions`, `x402` |
| `actions` | No | `{ actions_json }`, an `https://` URL on a listed domain |
| `agent` | No | `{ registry: "solana-agent-registry", id }` |
| `security` | No | `{ contact, policy, bug_bounty, audits: [{ auditor, report, date, programs }] }` |
| `extensions` | No | Object keyed by reverse-DNS namespace, e.g. `fun.gwapspot` |

Categories: `defi`, `dex`, `lending`, `payments`, `wallet`, `nft`, `marketplace`, `gaming`, `social`, `identity`, `infrastructure`, `developer-tools`, `dao`, `ai-agent`, `data`, `depin`, `media`, `other`.

**Hashing**

1. Parse the fetched bytes as JSON (UTF-8, at most 64 KiB).
2. Serialize with RFC 8785 (JSON Canonicalization Scheme). Manifests MUST NOT contain non-integer numbers.
3. `manifest_hash = SHA-256(canonical bytes)`.

Because the hash covers the canonical form, hosts can pretty-print or reorder keys without breaking it.

**Hosting:** `ar://` or `ipfs://` is RECOMMENDED. `https://` is allowed; a changed file simply fails the hash check. Clients SHOULD time out after 10 seconds and follow at most 3 redirects for the manifest itself.

**A manifest is valid only if** the hash matches, it passes the schema for its declared version, `app_id` equals the record address and `cluster` equals the record's cluster. Binding `app_id` stops a copied manifest from working for anyone else's record.

**Example** (addresses are placeholders)

```json
{
  "oar": "0.1",
  "app_id": "AppGwapSpot1111111111111111111111111111111",
  "cluster": "solana:mainnet",
  "name": "GwapSpot",
  "summary": "Reputation-based creator and deal marketplace on Solana.",
  "categories": ["marketplace", "identity"],
  "publisher": { "name": "GWAP", "url": "https://gwapspot.fun" },
  "domains": ["gwapspot.fun"],
  "links": { "website": "https://gwapspot.fun", "x": "https://x.com/_GwapSpot", "github": "https://github.com/gwapupward-hub" },
  "repositories": [{ "url": "https://github.com/gwapupward-hub/ppv", "role": "program" }],
  "programs": [{ "address": "PPVCore111111111111111111111111111111111111", "cluster": "solana:devnet", "name": "PPV Core", "role": "proofs" }],
  "interfaces": ["wallet-standard"],
  "security": { "contact": "mailto:security@gwapspot.fun" }
}
```

## Link proofs

A claim counts only when the other side points back to the same App ID on the same cluster. Each check below needs no OAR server: any client can run it.

**Programs: Program Metadata backlink**

The program's upgrade authority writes a canonical Program Metadata account with seed `oar`. Canonical accounts are PDAs of `[program, seed]` under the Program Metadata program (`ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S`), and only the upgrade authority can create one. Seeds are fixed 16-byte UTF-8, so `oar` fits.

Content, JSON format:

```json
{ "oar": "0.1", "app": "<App ID>", "cluster": "solana:mainnet" }
```

Publish it with the existing CLI. `--export <vault>` produces transactions for a Squads multisig instead of signing.

```bash
npx @solana-program/program-metadata@latest write oar <PROGRAM_ID> ./oar-link.json --format json
```

The program link is verified when all of these hold:

1. The canonical account for `(program, "oar")` exists on the program's cluster, is owned by the Program Metadata program, and its `canonical` flag is true.
2. It uses the direct data source, so the content is stored onchain under the authority's signature. URL and external data sources are rejected.
3. Its content parses and `app` and `cluster` match the record.
4. The current manifest lists the program with that cluster.

Consequences: a program can back-link to at most one app per cluster, so two apps can never both verify the same program. Programs that are already immutable cannot get a canonical account; they need an issuer attestation instead (see Attestations). Teams SHOULD write the backlink before freezing a program.

**Domains: well-known file or DNS**

Serve `https://<host>/.well-known/oar.json`:

```json
{ "oar": "0.1", "apps": [{ "app_id": "<App ID>", "cluster": "solana:mainnet" }] }
```

- HTTPS with a valid certificate, status 200, at most 16 KiB, and no redirects. Any redirect fails the check, because it would move the proof to another host.
- The host matches exactly. `www.gwapspot.fun` and `gwapspot.fun` are separate claims.
- Alternative: a DNS TXT record at `_oar.<host>` with value `oar=solana:mainnet:<App ID>`.
- Verified when the manifest lists the host and either proof names the App ID and cluster.

Serving the file is the proof of control, so no signature is needed in it.

**Repositories: committed file**

Commit the same JSON as `oar.json` at the repository root on the default branch. For GitHub, clients fetch `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/oar.json`. Verified when the manifest lists the repository URL and the file names the App ID and cluster.

**Builds: derived, not claimed**

**Planned capability, not implemented:** a program may show "build verified" only when its program link is verified and OtterSec's verify PDA (program `verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC`) or the [verify.osec.io API](https://github.com/otter-sec/solana-verified-programs-api) reports a match. It shows "source verified" only if that build's repository is also a verified repository of the app.

## Attestations

Issuers record the result of a link-proof check as a Solana Attestation Service attestation, so clients that cannot run HTTP checks (wallet signing screens, onchain programs) can still read a verdict. An attestation never adds a claim: clients MUST still find the claim in the current manifest.

**SAS accounts used** (program `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG`)

- Credential (the issuer): PDA `["credential", authority, name]`.
- Schema: PDA `["schema", credential, name, version]`, version a single byte. Every issuer creates its own copy of each `oar-*` schema with the exact layout below.
- Attestation: PDA `["attestation", credential, schema, nonce]`, holding `data`, `signer` and `expiry`. Its first byte is 2, and an `expiry` of 0 means it never expires.

**Supported link schemas, version 2; build/audit definitions below are planned version-1 placeholders, not accepted by the resolver** (layout codes are SAS type codes: 0 `u8`, 8 `i64`, 12 `String`, 13 `Vec<u8>`, 24 `Vec<String>`)

| Schema | Fields in order (layout code) | Subject used in nonce | Default expiry |
| --- | --- | --- | --- |
| `oar-domain` | `app_id` (13), `app_cluster` (12), `host` (12), `method` (0: 0 well-known, 1 DNS), `checked_at` (8) | host | 30 days |
| `oar-repo` | `app_id` (13), `app_cluster` (12), `url` (12), `checked_at` (8) | repository URL | 30 days |
| `oar-program` | `app_id` (13), `app_cluster` (12), `program` (13), `program_cluster` (12), `method` (0: 0 canonical backlink only), `checked_at` (8) | program address | 90 days |
| `oar-build` | `app_id` (13), `program` (13), `executable_hash` (13), `repo` (12), `commit` (12), `checked_at` (8) | program address | 90 days, or until the program is upgraded |
| `oar-audit` | `app_id` (13), `auditor` (12), `report` (12), `report_sha256` (13), `programs` (24), `audited_at` (8) | report URL | Optional |

`app_id`, `program` and hashes are raw 32-byte values. `checked_at` is Unix seconds.

**Deterministic nonce:** SHA-256 of UTF-8 `JSON.stringify(["oar", schema_version, schema, app_id_base58, app_cluster, subject, program_cluster_or_empty_string])`, used as a 32-byte address. Version-1 evidence is rejected by the hardened resolver. Payload and the actual schema account must match in full; the nonce alone is insufficient. Given a trusted credential, a client derives the exact attestation address for any claim with no indexer.

**Finding every attestation for an app:** because `app_id` is always the first field, it sits at a fixed offset. Run `getProgramAccounts` on the SAS program with memcmp at offset 101 for the length bytes `20 00 00 00` and at offset 105 for the 32-byte App ID, then keep only credentials you trust (offset 33).

**Issuer duties**

1. Attest only after running the matching check in Link proofs.
2. Re-check at least daily and whenever `ManifestUpdated` fires; close the attestation when a check fails.
3. Issuer-asserted immutable-program evidence is deferred. The current verifier rejects program methods other than 0; no historical-signature method is implemented.

**Clients** keep an explicit list of trusted credentials and MUST treat expired attestations as absent. The reference SDK ships an empty default trust list. Integrators explicitly select credentials after SAS compatibility and issuer operations are reviewed. No reference verifier service is implemented in this package. Explorers SHOULD show the issuer beside each badge.

## Resolution and display

A wallet follows program metadata, the registry, and individual claims; RPC read count grows with claims and issuers, and shows the app's name only when the program's own upgrade authority confirmed the link.

**`resolveProgram(program, cluster)`**

1. Read the canonical Program Metadata account for `(program, "oar")` on `cluster`. None means no app; return null.
2. Parse it to get the App ID and its cluster, then read that `AppRecord`. Missing means a broken link; return null.
3. Run `resolveApp`. Mark the program link verified only if the manifest lists this program on this cluster.

**`resolveApp(appId, cluster, trustedIssuers)`**

1. Read the `AppRecord`; check owner and discriminator.
2. Fetch the manifest, enforce size and time limits, canonicalize, hash and compare. Validate the schema and the `app_id` and `cluster` binding.
3. For each claim, compute its link state from a live check, a trusted unexpired attestation, or both.
4. Return the record, the manifest (or the reason it is invalid) and one state per claim.

**Link states**

| State | Meaning | Shown as |
| --- | --- | --- |
| `verified` | Live check passed, or the program backlink matches | Check mark |
| `attested` | A trusted, unexpired attestation exists; no live check run | Check mark plus issuer name |
| `unverified` | Claimed, but no proof found | Grey, plain text |
| `failed` | Proof points to a different App ID or cluster | Warning |

**Display rules for wallets and explorers**

1. Never show one overall "Verified" badge. Show one chip per link: domain, program, repository, build.
2. On a signing screen, show the app name for a program only when that program link is `verified`. Otherwise show the address as today.
3. If no domain or program link is verified, prefix the name with "Unverified" and keep the App ID visible.
4. An invalid or unreachable manifest shows "metadata unavailable" with the App ID and authority. A cached manifest MAY be shown only with its revision and age.
5. Retired apps show "Retired" and no chips. Deprecated apps show "Deprecated" beside the name.
6. When the connecting site's origin is a verified domain of the app that owns the called program, wallets MAY say so. A mismatch is information, not a block, because one transaction can touch many apps' programs.
7. Render all manifest text as plain text, and show hostnames in punycode when they contain non-ASCII characters.

## Interoperability

OAR references existing ecosystem records instead of copying them; v0.1 verifies only what it can prove bidirectionally.

| System | How OAR uses it | Verified in v0.1 |
| --- | --- | --- |
| Program Metadata | Program to app backlink, seed `oar` | Yes |
| Solana Attestation Service | Badges as `oar-*` attestations | Yes, per trusted issuer |
| OtterSec verified builds | Planned adapter; no build/source chips are emitted by this SDK | Planned |
| `solana-security-txt` | Embedded in program; binary extraction/display adapter is not implemented by this SDK | Planned reader |
| Clear Sign (sRFC 39) | Complementary: OAR says who, Clear Sign says what the instruction does. Both ship through Program Metadata | Not applicable |
| Solana Actions | `actions.actions_json` shown as verified only when its host is a verified domain | Yes, via domain |
| Wallet Standard | Cluster names use its chain IDs | Not applicable |
| Solana Mobile dApp Store | `platforms.android.dapp_store_app` holds the App NFT mint | No, reference only |
| Solana Agent Registry | `agent.id` references the agent identity | No, reference only |
| Name services (SNS and others) | Allowed under `extensions` | No |

The last three are open questions: each needs a backlink from that system's record to the App ID before OAR can show it as verified.

## Threat model

The main attack is impersonation, and the defence is that names prove nothing while links are checked from both sides. The largest residual risk is a compromised authority key.

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Registering a famous app's name | Names are metadata; display rules demand verified links before a name is shown as the app | Users who ignore "Unverified" labels |
| Copying another app's manifest | `app_id` binding in the manifest; backlinks point to the real App ID | None known |
| Squatting or front-running an App ID | Creator key is in the PDA seeds | None known |
| Spam registrations | Rent cost per record; no global names to claim; explorers rank by verified links | Indexer storage cost |
| Authority key theft | Squads vault authority recommended; two-step transfer; owners can Retire; issuers stop attesting | Thief can edit the manifest until noticed. Program and domain backlinks still need separate keys |
| Program upgrade-authority theft | Out of scope; backlink changes are visible to indexers, which SHOULD alert | Same as today without OAR |
| Domain expiry or takeover | Attestations expire after 30 days; live checks catch a changed file | Up to 30 days of a stale attestation |
| Manifest host changes or disappears | Hash check fails; shown as "metadata unavailable" | Availability, not integrity |
| Malicious manifest content | Plain-text rendering only; size limits; raster icons with hash | Client bugs |
| Look-alike hostnames | Proofs verify control, not intent; punycode display | Users misreading names |
| Compromised or careless issuer | Client-chosen issuer lists; issuer shown per badge; attestations are public and auditable | Clients trusting a bad issuer |
| Registry program upgrade abuse | Upgrade authority in a multisig with outside signers; verified build; freeze at v1.0 | Until frozen |
| Cluster confusion | Cluster in the manifest, backlink and well-known file | None known |

## SDK and CLI

The reference SDK is a TypeScript package on `@solana/kit`; the CLI is a thin wrapper over it, so every CLI command maps to one SDK call. Working package names are `@open-app-registry/sdk` and `@open-app-registry/cli` (binary `oar`); both were unclaimed on npm on 2026-10-03.

**SDK surface**

| Area | Functions |
| --- | --- |
| Addresses | `OAR_PROGRAM_ID`, `findAppId({ creator, nonce })` |
| Records | `fetchAppRecord(rpc, appId)`, `decodeAppRecord(bytes)` |
| Manifest | `canonicalizeManifest(m)`, `hashManifest(m)`, `validateManifest(m)`, `fetchManifest(uri, opts)` |
| Instructions | `getRegisterInstruction`, `getUpdateManifestInstruction`, `getProposeAuthorityInstruction`, `getAcceptAuthorityInstruction`, `getSetStatusInstruction` |
| Link proofs | `fetchProgramBacklink(rpc, program)`, `checkDomain(host, appId, cluster)`, `checkRepository(url, appId, cluster)` |
| Attestations | `deriveAttestationNonce(schema, appId, subject, { appCluster, programCluster? })` |
| Resolution | `resolveApp(rpc, appId, opts)`, `resolveProgram(rpc, program, opts)` |

**CLI commands**

| Command | Does |
| --- | --- |
| `oar init` | Writes a manifest template |
| `oar validate <file>` | Checks a manifest against the schema |
| `oar hash <file>` | Prints the canonical SHA-256 |
| `oar app-id --creator <key> --nonce <n>` | Derives an App ID before registering |
| `oar register` | Sends `register`; refuses a manifest whose `app_id` or `cluster` does not match |
| `oar update` | Sends `update_manifest`, with the same check |
| `oar set-status` | Sends `set_status`; Retired requires `--yes` |
| `oar propose-authority` / `oar accept-authority` | The two-step authority transfer |
| `oar link-file --app <id>` | Writes `oar-link.json` and prints the Program Metadata command |
| `oar well-known --app <id>` | Writes `.well-known/oar.json` |
| `oar verify-domain <host> --app <id>` | Runs the domain check |
| `oar inspect <appId>` | Prints `resolveApp` output |
| `oar resolve-program <program>` | Prints `resolveProgram` output |

## Governance, versioning and rollout

GWAP builds and runs the first implementation, but control of the registry program moves to a multisig with outside signers before mainnet and is frozen at v1.0.

**Governance**

- Registry upgrade authority: a Squads multisig, initially 2 of 3 with at least one signer from outside GWAP.
- Every release ships as an OtterSec verified build, with its IDL uploaded through Program Metadata and a `security.txt` embedded.
- The program is frozen after an external audit and six months of stable mainnet use; that freeze is v1.0.
- The spec lives in a public repository under an open license; changes go through public pull requests and the sRFC thread.

**Versioning**

- Manifest `oar` is `major.minor`. The current implementation accepts exactly `0.1` and rejects unknown fields except namespaced `extensions`. Newer minor versions require an explicitly supported schema; automatic forward compatibility is not promised.
- `layout_version` covers the account. A new layout ships as a new instruction set with an explicit migration, never a silent reinterpretation.
- SAS schemas are versioned by their one-byte schema version; a changed layout is a new version.

**sRFC path:** sRFCs have no formal acceptance; the author drives consensus. Post the draft as a discussion on [solana-foundation/SRFCs](https://github.com/solana-foundation/SRFCs) once the devnet program, SDK and one working resolver exist, so reviewers can run it.

**Rollout**

&#91;embedded content: OAR rollout · 5 phases, 4 gates\]

Phases are sequential and not to scale; a phase starts only when the gate above it passes.

## Open questions

- [ ] **Final name.** Keep "Open App Registry (OAR)" or pick another before the sRFC post; four constants change with it.
- [ ] **PDA only, or also an NFT?** Solana Agent Registry pairs each identity with an NFT for wallet visibility and transfer. v0.1 uses a bare PDA with a rotatable authority.
- [ ] **Registration fee.** v0.1 charges only rent. A fee would deter spam but cuts against neutrality.
- [ ] **Solana Mobile backlink.** How an App NFT proves it belongs to an App ID, for example a field in its metadata.
- [ ] **Agent Registry backlink.** The same question for agent identities.
- [ ] **Name services.** Whether `.sol` or other names get a defined proof, or stay in `extensions`.
- [ ] **Default issuers.** Which credentials the reference SDK trusts out of the box, and how an issuer is added.
- [ ] **Immutable programs.** What evidence an issuer must publish before asserting a link for a frozen program.
- [ ] **One App ID across clusters.** v0.1 lets a mainnet App ID claim devnet programs. Confirm this rather than one App ID per cluster.

## Hardening candidate acceptance requirements

- Supported link attestations require positive `checked_at` no later than the verifier clock, nonzero expiry later than `checked_at`, expiry no later than `checked_at + schema TTL`, and `now < expiry`. Exact expiry is expired. No grace period is applied.
- The supplied program-address keypair was exposed. That public ID and historical binary are local-test-only; distribution excludes signer material. Fresh program identity changes registry-derived App IDs and requires new manifests/backlinks.
- Node hosted HTTP must reject private/special-use destinations and pin checked DNS answers at connection time. Custom fetch transports are trusted adapters and must provide equivalent policy. HTTP/DNS/body work is time bounded; malformed dependency evidence fails closed.
- AppRecords require expected owner, discriminator, exact allocation, supported layout/status and matching PDA/bump before claims are resolved.
- Actions URLs require a listed exact host. This validates declaration only; it does not create an Actions badge.
- Production deployment requires fresh/reproducible builds, reviewed immutable builder/toolchain pins, IDL/client consistency, dependency/security review, approved fresh identity, SAS and devnet rehearsal, verified governance, operations/rollback evidence and explicit final authorization. No deployment has been performed.

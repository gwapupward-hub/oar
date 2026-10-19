# Verification states and manifest URI policy

How SDK consumers (CLI, explorer, wallets, the starter) must present OAR
evidence, and which manifest locations registration accepts.

## Claim states

Every claim in a resolved app (`programs`, `domains`, `repositories`) has one
`state`, plus an optional `retryable` flag.

| SDK result | Display as | Meaning |
|---|---|---|
| `state: 'verified'` | Linked (per kind: program / domain / repository) | Reciprocal evidence: the manifest claims the subject and the subject's own proof (program backlink, `/.well-known/oar.json` or DNS TXT, root `oar.json`) names this App ID on this cluster. |
| `state: 'attested'` | Attested by `<issuer>` | No live proof, but a valid, unexpired attestation from an issuer **this client explicitly trusts**. No issuer is trusted by default. |
| `state: 'unverified'` | Unverified | The proof is missing or incomplete. Not a statement that the subject is unsafe. |
| `state: 'unverified', retryable: true` | Temporarily unavailable — retry | An RPC, HTTP (timeout, network, 429, 5xx) or DNS read could not complete, so absence is not established. Never show this as a failure. |
| `state: 'failed'` | Disputed / invalid | Evidence that was successfully read contradicts the claim (names another App ID or cluster, or is malformed). |

Rules:

- `failed` is only ever produced from data that was actually read. A transport
  failure can never produce `failed` (see `docs/RPC-UNAVAILABILITY.md`).
- `retryable` appears only on `unverified`.
- An AppRecord that could not be read is `OarRpcUnavailableError` from
  `resolveApp`, and `{ status: 'unavailable' }` from `resolveProgram`; the CLI
  exits 2. Neither is "not registered".
- Registration alone proves only that a creator wallet signed a record. It is
  never an audit, an endorsement, or verification. Show the app name as
  unverified until at least one program or domain claim is `verified` (or
  `attested` by an issuer the client trusts).

## Manifest URI policy

`checkManifestUri(uri)` (exported from the SDK root and from
`@open-app-registry/sdk/register`) runs inside `checkManifestHosting`, which the
CLI's `register`, `update` and `claim register` call before signing, and inside
`buildClaimFiles` (`oar claim prepare`). The starter's `oar:prepare` applies the
same rule.

Accepted:

- `ar://…` and `ipfs://…` (content-addressed).
- Raw source-forge URLs that name a full commit SHA (40 or 64 lowercase hex):
  `raw.githubusercontent.com/<o>/<r>/<sha>/…`, `github.com/<o>/<r>/raw/<sha>/…`,
  `gitlab.com/…/-/raw/<sha>/…`, `cdn.jsdelivr.net/gh/<o>/<r>@<sha>/…`.
- Any other `https://` location, such as the default
  `https://<domain>/.well-known/oar-manifest.json`. Its content is pinned by the
  onchain hash; changing the file without `oar update` makes the record show
  "metadata unavailable", not different metadata.

Refused:

- Branch, tag, `HEAD` or short-SHA references on those forges
  (`…/main/…`, `…/refs/heads/main/…`, `…/HEAD/…`), and GitHub release assets.
  They would break the record the next time the reference moves.
- Any manifest whose file name is `oar.json`. That name is reserved for the
  domain proof (`/.well-known/oar.json`) and the repository proof (root
  `oar.json`), so a proof file can never double as a manifest.
- Non-HTTPS schemes, embedded credentials, and URIs over 256 bytes.

The repository proof is deliberately read from the default branch (`HEAD`): it
is a live statement by the repository's current owner and can be withdrawn.

# OAR RPC outage proof-state handling

The verifier MUST distinguish a transport failure from an invalid on-chain proof.

## Backlink read outcomes

| Result | Meaning | UI claim state |
|---|---|---|
| `ok` | Canonical backlink decoded and schema valid | `verified` if it matches; `failed` if it names a different App ID or cluster |
| `none` | Confirmed metadata account absence | `unverified` |
| `invalid` | Confirmed on-chain account is malformed, not canonical, mismatched or invalid | `failed` |
| `unavailable` | RPC read threw or timed out | `unverified`, with retry hint |

RPC outages MUST NOT create `failed` claims or suppress independent trusted issuer attestations.
The UI MAY still show an `attested` claim with a configured trusted issuer
even when canonical program-link verification is temporarily unavailable.
No trusted issuer is configured by default.

## Resolver API behavior

- `fetchProgramBacklink` returns `status: 'unavailable'` for RPC transport errors.
- `backlinkMatches` maps `unavailable` to `unverified` with a retry hint.
- `resolveProgram` returns `{ status: 'unavailable', program, detail }`
  when backlink or AppRecord RPC access fails (or no RPC is configured for
  the backlink's cluster); `null` remains for legitimately absent/invalid
  resolution, not transport failure.
- `resolveApp` throws `OarRpcUnavailableError` for a failed AppRecord
  RPC read instead of returning `null`; malformed or missing successfully
  fetched records still return `null`.
- CLI `resolve-program` returns exit code 2 for unavailable RPC,
  including JSON output, distinct from absence (exit code 1).
- The generated Next.js resolver surfaces the retryable condition as
  an error rather than calling the program unverified/unsafe.

**Release boundary:** SDK code and tests are not an npm release.
The installed SDK release candidate remains unchanged until separately
versioned and published. Production clients must handle the new union
and retryable exception before upgrading.

## Validation

Tests simulate a dropped metadata-account RPC and a dropped AppRecord RPC,
verify `unverified`/retry behavior and explicit `unavailable` program
resolution, preserve valid trusted SAS attestations, and ensure corrupt
successfully-read metadata still returns `failed`. CI must also run the
existing Rust, SDK, CLI, and dependency checks. No private keys, deployment,
or governance change is part of this patch.

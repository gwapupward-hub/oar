# OAR's own domain evidence (Devnet)

App ID: `Bu1JCyxiVDdDGjtNLLkKhq6KZv6E4LcUgqNkS5t5Nf2K`.
Domain: `oarprotocol.xyz`. Cluster: `solana:devnet`.

The prepared manifest in `release/devnet/oar.manifest.json` includes the website domain. The explorer repository
`gwapupward-hub/oar-web` serves its reciprocal proof at `https://oarprotocol.xyz/.well-known/oar.json`.
Publishing either file alone does **not** change the live AppRecord or prove the complete link.
The existing record pins its earlier manifest's immutable URI and hash until its authority signs an update.

## Complete the link

1. Release the website proof and confirm it returns HTTP 200 without a redirect. Its `apps` entry must name the App ID above and `solana:devnet`.
2. Merge the prepared protocol manifest. Pin its raw URI to the **full commit SHA containing these exact bytes**, never `main`:
   `https://raw.githubusercontent.com/gwapupward-hub/oar/<FULL_COMMIT_SHA>/release/devnet/oar.manifest.json`.
3. At `https://oarprotocol.xyz/register`, connect the **current AppRecord authority** wallet on Devnet. Use the existing **Update** card with this App ID and the pinned URI. Review and sign the manifest update. This preserves the App ID and program backlink.
4. Alternatively, an operator who already controls that authority can use the built CLI locally:

   ```bash
   node packages/cli/dist/index.js update \
     --app Bu1JCyxiVDdDGjtNLLkKhq6KZv6E4LcUgqNkS5t5Nf2K \
     --manifest release/devnet/oar.manifest.json \
     --uri https://raw.githubusercontent.com/gwapupward-hub/oar/<FULL_COMMIT_SHA>/release/devnet/oar.manifest.json \
     --cluster devnet --keypair <LOCAL_AUTHORITY_KEYPAIR_PATH>
   ```

   Resolve the placeholders locally. Never send a private key, seed phrase or keypair file in chat.
   Do not run `devnet:oar-app publish` to replace an existing manifest: that command deliberately rejects a different existing record.
5. After finalization and the explorer's approximately one-minute cache, open the App ID page.
   Require a valid manifest plus **Program linked**, **Repository linked**, and **Domain linked** for `oarprotocol.xyz`.
   Save the transaction signature, committed manifest URI/hash and checked-at time as release evidence.

The domain proof demonstrates control of the website. It does not certify safety, endorsements, or Mainnet readiness.
The mainnet release gates remain unchanged.

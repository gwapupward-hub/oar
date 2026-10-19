# @open-app-registry/sdk

TypeScript SDK for the [Open App Registry (OAR)](https://github.com/gwapupward-hub/oar), an experimental, permissionless application identity registry for Solana.

> **Release-candidate software. Devnet only.** OAR identity proofs are not security audits or endorsements. The OAR registry program is **not** deployed to mainnet.

## Install

The pre-release is distributed through the `next` npm dist-tag:

```bash
npm install @open-app-registry/sdk@next @solana/kit
```

For reproducible applications, pin a tested SDK version (for example `@open-app-registry/sdk@0.1.1-rc.3`) instead of the moving dist-tag.

## Resolve a program

```ts
import { address, createSolanaRpc } from '@solana/kit'
import { resolveProgram } from '@open-app-registry/sdk'

const rpc = createSolanaRpc('https://api.devnet.solana.com')
const result = await resolveProgram(rpc, address('YOUR_PROGRAM_ID'), {
  cluster: 'solana:devnet',
})

if (result?.link?.state === 'verified') {
  console.log('Verified reciprocal program link:', result.app.appId)
}
```

An OAR record can identify an app without verifying all of its claims. Display a program-to-app affiliation as verified **only** if the reciprocal proof has been checked and its state is `verified`. An RPC outage must not be displayed as evidence of a failed or fraudulent claim.

## Documentation

- [OAR repository and complete SDK overview](https://github.com/gwapupward-hub/oar#sdk)
- [Specification](https://github.com/gwapupward-hub/oar/blob/main/docs/spec-v0.1.md)
- [Registration guide](https://github.com/gwapupward-hub/oar/blob/main/docs/REGISTERING.md)
- [Production readiness and limitations](https://github.com/gwapupward-hub/oar/blob/main/docs/PRODUCTION-READINESS.md)

License: Apache-2.0.

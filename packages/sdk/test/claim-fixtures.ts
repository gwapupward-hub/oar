import { getAddressEncoder, type Address } from '@solana/kit';
import * as sas from 'sas-lib';
import { OAR_SCHEMAS, deriveSchemaPda, deriveAttestationNonce, deriveAttestationPda, SAS_PROGRAM_ID, type OarSchemaName, type Cluster } from '../src/index.js';
import { setRawAccount } from './helpers.js';
import type { LiteSVM } from 'litesvm';
export function fieldBytes(fields: readonly string[]): Uint8Array {
  return Uint8Array.from(fields.flatMap(f => [f.length, 0, 0, 0, ...new TextEncoder().encode(f)]));
}
export async function putClaim(svm: LiteSVM, args: {
  credential: Address; appId: Address; schema: OarSchemaName; subject: string;
  appCluster: Cluster; programCluster?: Cluster; now: bigint; expiry?: bigint;
  payload: Record<string, unknown>; rawData?: Uint8Array; schemaLayout?: readonly number[]; paused?: boolean;
  /** Attestation signer (default: the credential address) and the credential's current authorized signers. */
  signer?: Address; authorizedSigners?: Address[];
}) {
  const def = OAR_SCHEMAS[args.schema];
  const schema = await deriveSchemaPda(args.credential, args.schema, def.version);
  const nonce = deriveAttestationNonce(args.schema, args.appId, args.subject, args);
  const address = await deriveAttestationPda(args.credential, schema, nonce);
  const fields = fieldBytes(def.fields);
  const signer = args.signer ?? args.credential;
  setRawAccount(svm, args.credential, SAS_PROGRAM_ID, Uint8Array.from(sas.getCredentialEncoder().encode({
    discriminator: 0, authority: args.credential, name: new TextEncoder().encode('oar-test'), authorizedSigners: args.authorizedSigners ?? [signer],
  })));
  setRawAccount(svm, schema, SAS_PROGRAM_ID, Uint8Array.from(sas.getSchemaEncoder().encode({
    discriminator: 1, credential: args.credential, name: new TextEncoder().encode(args.schema), description: new Uint8Array(),
    layout: Uint8Array.from(args.schemaLayout ?? def.layout), fieldNames: fields, isPaused: args.paused ?? false, version: def.version,
  })));
  const data = args.rawData ?? sas.serializeAttestationData({ layout: Uint8Array.from(def.layout), fieldNames: fields } as never, {
    app_id: Array.from(getAddressEncoder().encode(args.appId)), app_cluster: args.appCluster,
    ...(args.programCluster ? { program_cluster: args.programCluster } : {}), checked_at: args.now, ...args.payload,
  });
  setRawAccount(svm, address, SAS_PROGRAM_ID, Uint8Array.from(sas.getAttestationEncoder().encode({
    discriminator: 2, nonce, credential: args.credential, schema, data, signer,
    expiry: args.expiry ?? args.now + 100n, tokenAccount: '11111111111111111111111111111111' as Address,
  })));
  return address;
}

import {
  fetchEncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getI64Decoder,
  getProgramDerivedAddress,
  getU32Decoder,
  type Address,
  type GetAccountInfoApi,
  type Rpc,
} from '@solana/kit';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesEqual } from './manifest.js';
import type { Cluster } from './constants.js';
import { SAS_PROGRAM_ID } from './constants.js';

/**
 * OAR schemas on the Solana Attestation Service. Layout codes are SAS type
 * codes (0 u8, 8 i64, 12 String, 13 Vec<u8>, 24 Vec<String>). `app_id` is
 * always the first field so every attestation for an app sits at a fixed
 * offset (see ATTESTATION_APP_ID_OFFSET).
 */
export const OAR_SCHEMAS = {
  'oar-domain': { version: 2, layout: [13, 12, 12, 0, 8], fields: ['app_id', 'app_cluster', 'host', 'method', 'checked_at'], expirySeconds: 30 * 86400 },
  'oar-repo': { version: 2, layout: [13, 12, 12, 8], fields: ['app_id', 'app_cluster', 'url', 'checked_at'], expirySeconds: 30 * 86400 },
  'oar-program': { version: 2, layout: [13, 12, 13, 12, 0, 8], fields: ['app_id', 'app_cluster', 'program', 'program_cluster', 'method', 'checked_at'], expirySeconds: 90 * 86400 },
  'oar-build': {
    version: 1,
    layout: [13, 13, 13, 12, 12, 8],
    fields: ['app_id', 'program', 'executable_hash', 'repo', 'commit', 'checked_at'],
    expirySeconds: 90 * 86400,
  },
  'oar-audit': {
    version: 1,
    layout: [13, 12, 12, 13, 24, 8],
    fields: ['app_id', 'auditor', 'report', 'report_sha256', 'programs', 'audited_at'],
    expirySeconds: null,
  },
} as const;

export type OarSchemaName = keyof typeof OAR_SCHEMAS;

/** SAS account discriminators (upstream program): Credential 0, Schema 1, Attestation 2. */
export const SAS_CREDENTIAL_DISCRIMINATOR = 0;
/** SAS Attestation account: disc u8 | nonce | credential | schema | u32 len | data | signer | expiry i64 | token_account. */
export const SAS_ATTESTATION_DISCRIMINATOR = 2;
export const ATTESTATION_DATA_OFFSET = 101;
/** Offset of the 32 App ID bytes (after the Vec<u8> u32 length at 101). */
export const ATTESTATION_APP_ID_OFFSET = 105;

const addressEncoder = getAddressEncoder();
const addressDecoder = getAddressDecoder();

export async function deriveCredentialPda(authority: Address, name: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SAS_PROGRAM_ID,
    seeds: ['credential', addressEncoder.encode(authority), name],
  });
  return pda;
}

export async function deriveSchemaPda(credential: Address, name: string, version: number): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SAS_PROGRAM_ID,
    seeds: ['schema', addressEncoder.encode(credential), name, Uint8Array.of(version)],
  });
  return pda;
}

export async function deriveAttestationPda(credential: Address, schema: Address, nonce: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: SAS_PROGRAM_ID,
    seeds: ['attestation', addressEncoder.encode(credential), addressEncoder.encode(schema), addressEncoder.encode(nonce)],
  });
  return pda;
}

/** SHA-256 of a length-unambiguous JSON tuple including schema version and cluster context. */
export function deriveAttestationNonce(schema: OarSchemaName, appId: string, subject: string, context: { appCluster: Cluster; programCluster?: Cluster }): Address {
  const digest = sha256(new TextEncoder().encode(JSON.stringify(['oar', OAR_SCHEMAS[schema].version, schema, appId, context.appCluster, subject, context.programCluster ?? ''])));
  return addressDecoder.decode(digest);
}

export interface DecodedAttestation {
  nonce: Address;
  credential: Address;
  schema: Address;
  data: Uint8Array;
  signer: Address;
  /** Unix seconds; 0 means it never expires (SAS convention). */
  expiry: bigint;
  tokenAccount: Address;
}

export function decodeAttestation(bytes: Uint8Array): DecodedAttestation {
  if (bytes.length < 173) throw new Error('Short SAS account');
  if (bytes[0] !== SAS_ATTESTATION_DISCRIMINATOR) throw new Error('Not a SAS attestation account');
  const len = getU32Decoder().decode(bytes, 97);
  const dataEnd = ATTESTATION_DATA_OFFSET + len;
  if (dataEnd + 72 !== bytes.length) throw new Error('Invalid SAS length');
  return {
    nonce: addressDecoder.decode(bytes, 1),
    credential: addressDecoder.decode(bytes, 33),
    schema: addressDecoder.decode(bytes, 65),
    data: bytes.slice(ATTESTATION_DATA_OFFSET, dataEnd),
    signer: addressDecoder.decode(bytes, dataEnd),
    expiry: getI64Decoder().decode(bytes, dataEnd + 32),
    tokenAccount: addressDecoder.decode(bytes, dataEnd + 40),
  };
}

export type ClaimAttestation =
  | { status: 'none'; address: Address }
  | { status: 'invalid' | 'expired' | 'mismatch'; address: Address }
  | { status: 'valid'; address: Address; credential: Address; signer: Address; expiry: bigint };

/** A bounded reader for the pinned SAS scalar wire format. */
class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(n: number): Uint8Array {
    if (n < 0 || this.offset + n > this.bytes.length) throw new Error('Truncated SAS data');
    const out = this.bytes.slice(this.offset, this.offset + n); this.offset += n; return out;
  }
  u8(): number { return this.take(1)[0]; }
  vec(): Uint8Array { const n = getU32Decoder().decode(this.take(4)); return this.take(n); }
  text(): string { return new TextDecoder('utf-8', { fatal: true }).decode(this.vec()); }
  id(): Address { const v = this.vec(); if (v.length !== 32) throw new Error('Expected 32-byte ID'); return addressDecoder.decode(v); }
  i64(): bigint { return getI64Decoder().decode(this.take(8)); }
  end(): void { if (this.offset !== this.bytes.length) throw new Error('Trailing SAS bytes'); }
}

/**
 * Signers a SAS credential authorizes now: disc u8 | authority | name Vec<u8> | authorized_signers Vec<Pubkey>.
 * Null when the bytes are not a credential.
 */
export function decodeCredentialSigners(bytes: Uint8Array): Address[] | null {
  try {
    const r = new Reader(bytes);
    if (r.u8() !== SAS_CREDENTIAL_DISCRIMINATOR) return null;
    r.take(32); r.vec();
    const count = getU32Decoder().decode(r.take(4));
    const out: Address[] = [];
    for (let i = 0; i < count; i++) out.push(addressDecoder.decode(r.take(32)));
    return out;
  } catch { return null; }
}

/** Decode and validate the actual SAS schema, not its name alone. */
export function validateClaimSchema(bytes: Uint8Array, credential: Address, name: OarSchemaName): boolean {
  try {
    const r = new Reader(bytes), def = OAR_SCHEMAS[name];
    if (r.u8() !== 1 || addressDecoder.decode(r.take(32)) !== credential || r.text() !== name) return false;
    r.text(); // Human-readable description has no verification authority.
    if (!bytesEqual(r.vec(), def.layout)) return false;
    const names = new Reader(r.vec());
    for (const field of def.fields) if (names.text() !== field) return false;
    names.end();
    if (r.u8() !== 0 || r.u8() !== def.version) return false; // paused schemas fail closed
    r.end(); return true;
  } catch { return false; }
}

/** Fully bind supported link attestations. Build and audit evidence remain unsupported. */
export async function fetchClaimAttestation(
  rpc: Rpc<GetAccountInfoApi>,
  args: { credential: Address; schema: OarSchemaName; appId: Address; subject: string;
    appCluster: Cluster; programCluster?: Cluster; nowSeconds?: bigint },
): Promise<ClaimAttestation> {
  const def = OAR_SCHEMAS[args.schema];
  const schemaPda = await deriveSchemaPda(args.credential, args.schema, def.version);
  const nonce = deriveAttestationNonce(args.schema, args.appId, args.subject, args);
  const address = await deriveAttestationPda(args.credential, schemaPda, nonce);
  if (!['oar-domain', 'oar-repo', 'oar-program'].includes(args.schema)) return { status: 'invalid', address };
  try {
    const account = await fetchEncodedAccount(rpc, address, { commitment: 'finalized' });
    if (!account.exists) return { status: 'none', address };
    if (account.programAddress !== SAS_PROGRAM_ID) return { status: 'invalid', address };
    const schema = await fetchEncodedAccount(rpc, schemaPda, { commitment: 'finalized' });
    if (!schema.exists || schema.programAddress !== SAS_PROGRAM_ID ||
        !validateClaimSchema(Uint8Array.from(schema.data), args.credential, args.schema)) return { status: 'invalid', address };
    const att = decodeAttestation(Uint8Array.from(account.data));
    if (att.nonce !== nonce || att.schema !== schemaPda || att.credential !== args.credential) return { status: 'mismatch', address };
    // SAS checks the signer only at issuance; removing a signer from the credential must also withdraw its evidence.
    const credential = await fetchEncodedAccount(rpc, args.credential, { commitment: 'finalized' });
    const signers = credential.exists && credential.programAddress === SAS_PROGRAM_ID ? decodeCredentialSigners(Uint8Array.from(credential.data)) : null;
    if (!signers?.includes(att.signer)) return { status: 'invalid', address };
    const r = new Reader(att.data);
    if (r.id() !== args.appId || r.text() !== args.appCluster) return { status: 'mismatch', address };
    if (args.schema === 'oar-program') {
      if (!args.programCluster || r.id() !== args.subject || r.text() !== args.programCluster) return { status: 'mismatch', address };
      if (r.u8() !== 0) return { status: 'invalid', address }; // canonical Program Metadata
    } else {
      if (r.text() !== args.subject) return { status: 'mismatch', address };
      if (args.schema === 'oar-domain' && ![0, 1].includes(r.u8())) return { status: 'invalid', address };
    }
    const checkedAt = r.i64(); r.end();
    const now = args.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
    const ttl = BigInt(def.expirySeconds!);
    if (checkedAt <= 0n || checkedAt > now || att.expiry === 0n || att.expiry > checkedAt + ttl || att.expiry <= checkedAt) return { status: 'invalid', address };
    if (att.expiry <= now || now - checkedAt >= ttl) return { status: 'expired', address };
    return { status: 'valid', address, credential: att.credential, signer: att.signer, expiry: att.expiry };
  } catch { return { status: 'invalid', address }; }
}

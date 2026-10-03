import { address, type Address } from '@solana/kit';
import { OAR_REGISTRY_PROGRAM_ADDRESS } from './generated/index.js';

/** OAR registry program (devnet reference deployment target). */
export const OAR_PROGRAM_ID: Address = OAR_REGISTRY_PROGRAM_ADDRESS;

export const OAR_SPEC_VERSION = '0.1' as const;

/** Program Metadata seed for program -> app backlinks (16-byte UTF-8 field). */
export const PROGRAM_METADATA_SEED = 'oar';
export const PROGRAM_METADATA_PROGRAM_ID = address('ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S');

/** Solana Attestation Service program. */
export const SAS_PROGRAM_ID = address('22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG');

/** OtterSec verified-builds program (holds build-parameter PDAs). */
export const OTTERSEC_VERIFY_PROGRAM_ID = address('verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC');

export const WELL_KNOWN_PATH = '/.well-known/oar.json';
export const REPO_PROOF_FILE = 'oar.json';
export const DNS_LABEL = '_oar';

/** Wallet Standard chain identifiers. */
export const CLUSTERS = ['solana:mainnet', 'solana:devnet', 'solana:testnet'] as const;
export type Cluster = (typeof CLUSTERS)[number];

export const AppStatus = { Active: 0, Deprecated: 1, Retired: 2 } as const;
export type AppStatusName = keyof typeof AppStatus;

export const MAX_URI_LEN = 256;
export const APP_RECORD_SIZE = 427;
/** memcmp offsets into AppRecord account data. */
export const APP_RECORD_OFFSETS = { creator: 11, authority: 51 } as const;

export const LIMITS = {
  manifestBytes: 64 * 1024,
  proofBytes: 16 * 1024,
  timeoutMs: 10_000,
  manifestRedirects: 3,
} as const;

export function isCluster(value: unknown): value is Cluster {
  return typeof value === 'string' && (CLUSTERS as readonly string[]).includes(value);
}

export function statusName(status: number): AppStatusName | 'Unknown' {
  const entry = Object.entries(AppStatus).find(([, v]) => v === status);
  return (entry?.[0] as AppStatusName | undefined) ?? 'Unknown';
}

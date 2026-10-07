// Registering an existing app: the transactions a team signs, built so a wallet, a Squads multisig or the CLI can
// show exactly what each one does before anyone signs. Pure @solana/kit and Program Metadata code with no Node APIs,
// so browser code can import it through `@open-app-registry/sdk/register`.
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createClientWithGetMinimumBalanceFromRpc,
  createNoopSigner,
  createTransactionMessage,
  fetchEncodedAccount,
  flattenInstructionPlan,
  getBase58Decoder,
  getBase64Decoder,
  getTransactionEncoder,
  getUtf8Decoder,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type GetAccountInfoApi,
  type GetMinimumBalanceForRentExemptionApi,
  type Instruction,
  type InstructionPlan,
  type ReadonlyUint8Array,
  type Rpc,
  type TransactionSigner,
} from '@solana/kit';
import {
  Compression,
  DataSource,
  Encoding,
  Format,
  fetchMaybeMetadata,
  findCanonicalPda,
  getAccountSize,
  getCreateMetadataInstructionPlanUsingInstructionData,
  getProgramAuthority,
  getUpdateMetadataInstructionPlanUsingInstructionData,
  unpackDirectData,
} from '@solana-program/program-metadata';
import { APP_RECORD_SIZE, OAR_PROGRAM_ID, PROGRAM_METADATA_PROGRAM_ID, PROGRAM_METADATA_SEED, type Cluster } from './constants.js';
import { findAppRecordPda } from './generated/index.js';
import { parseJsonStrict } from './json.js';
import type { Category, OarManifest } from './manifest.js';
import { buildProgramLink, buildProofFile, type ProofFile } from './proofs.js';

const SYSTEM_PROGRAM_ID = address('11111111111111111111111111111111');
const COMPUTE_BUDGET_PROGRAM_ID = address('ComputeBudget111111111111111111111111111111');

/** The only programs a registration transaction may call. Anything else is refused before signing. */
export const REGISTRATION_PROGRAMS: readonly Address[] = [OAR_PROGRAM_ID, PROGRAM_METADATA_PROGRAM_ID, SYSTEM_PROGRAM_ID, COMPUTE_BUDGET_PROGRAM_ID];

/** Throw unless every instruction targets the OAR registry, Program Metadata, System or Compute Budget program. */
export function assertRegistrationInstructions(instructions: readonly Instruction[]): void {
  for (const ix of instructions) {
    if (!REGISTRATION_PROGRAMS.includes(ix.programAddress)) {
      throw new Error(`Refusing to sign: an instruction calls ${ix.programAddress}, which is not part of OAR registration.`);
    }
  }
}

// ---------------------------------------------------------------------------
// App ID
// ---------------------------------------------------------------------------

/**
 * The first nonce at or after `from` with no AppRecord for this creator, and the App ID it derives. Any unused nonce
 * works; the lowest keeps App IDs predictable for a team registering several apps.
 */
export async function nextAppNonce(
  rpc: Rpc<GetAccountInfoApi>,
  creator: Address,
  { from = 0n, limit = 64n }: { from?: bigint; limit?: bigint } = {},
): Promise<{ nonce: bigint; appId: Address }> {
  for (let nonce = from; nonce < from + limit; nonce++) {
    const [appId] = await findAppRecordPda({ creator, nonce });
    const account = await fetchEncodedAccount(rpc, appId, { commitment: 'confirmed' });
    if (!account.exists) return { nonce, appId };
  }
  throw new Error(`No free nonce between ${from} and ${from + limit - 1n} for ${creator}; pass a higher starting nonce.`);
}

export interface ClaimInput {
  appId: Address;
  cluster: Cluster;
  name: string;
  summary?: string;
  categories?: Category[];
  /** Hostnames; lowercased here. The first one hosts the manifest by default. */
  domains?: string[];
  programs?: Address[];
  repositories?: string[];
  /** Where the manifest will be served; default `https://<first domain>/.well-known/oar-manifest.json`. */
  manifestUri?: string;
}

export interface ClaimFiles {
  /** Not yet validated: run `validateManifest` before hosting or registering it. */
  manifest: OarManifest;
  /** Serve at `https://<each domain>/.well-known/oar.json`. */
  wellKnown: ProofFile;
  /** Commit as `oar.json` at the root of each repository; present when repositories are listed. */
  repoProof?: ProofFile;
  manifestUri: string;
}

/** The manifest and proof files a team deploys before registering. Programs are claimed on the App ID's cluster. */
export function buildClaimFiles(input: ClaimInput): ClaimFiles {
  const domains = (input.domains ?? []).map(d => d.trim().toLowerCase()).filter(Boolean);
  const repositories = (input.repositories ?? []).map(r => r.trim()).filter(Boolean);
  const programs = input.programs ?? [];
  const manifestUri = input.manifestUri?.trim() || (domains[0] ? `https://${domains[0]}/.well-known/oar-manifest.json` : '');
  if (!manifestUri) throw new Error('Give a domain, or a URI where the manifest will be served.');
  const manifest: OarManifest = {
    oar: '0.1',
    app_id: input.appId,
    cluster: input.cluster,
    name: input.name,
    ...(input.summary ? { summary: input.summary } : {}),
    categories: input.categories?.length ? input.categories : ['other'],
    ...(domains.length ? { domains, links: { website: `https://${domains[0]}` } } : {}),
    ...(repositories.length ? { repositories: repositories.map(url => ({ url, role: 'app' as const })) } : {}),
    ...(programs.length ? { programs: programs.map(a => ({ address: a, cluster: input.cluster })) } : {}),
  };
  const proof = buildProofFile([{ appId: input.appId, cluster: input.cluster }]);
  return { manifest, wellKnown: proof, ...(repositories.length ? { repoProof: proof } : {}), manifestUri };
}

export interface RegistrationSummary {
  appId: Address;
  cluster: Cluster;
  creator: Address;
  nonce: bigint;
  authority: Address;
  manifestUri: string;
  manifestSha256: string;
}

/** What a `register` transaction does, in plain sentences, for the confirmation screen. */
export function describeRegistration(r: RegistrationSummary): string[] {
  const lines = [
    `Creates App ID ${r.appId} on ${r.cluster} (creator ${r.creator}, nonce ${r.nonce}).`,
    `Points it at the manifest ${r.manifestUri} with SHA-256 ${r.manifestSha256}.`,
    `Record authority: ${r.authority}. Only this key can update the manifest, change the status or hand over control.`,
  ];
  if (r.authority !== r.creator) {
    lines.push('The authority does not sign now. Explorers do not treat it as an endorsement until it signs an update.');
  }
  lines.push(`Cost: rent for a ${APP_RECORD_SIZE}-byte account (about 0.0039 SOL, paid by the creator) plus the network fee.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Program backlink (canonical Program Metadata account, seed "oar")
// ---------------------------------------------------------------------------

export interface ProgramLinkPlan {
  program: Address;
  /** Canonical metadata PDA of (program, "oar"). */
  metadata: Address;
  /** The program's current upgrade authority: the only key that can sign this. */
  upgradeAuthority: Address;
  action: 'create' | 'update' | 'unchanged';
  /** Exact JSON written onchain, uncompressed so signers can read it in the instruction data. */
  content: string;
  /** Current backlink content when one exists and is readable. */
  previous?: string;
  /** Lamports moved into the metadata account for rent (0 when unchanged or shrinking). */
  rentLamports: bigint;
  instructions: Instruction[];
}

/** Who can sign a program's backlink: its upgrade authority, or null when the program is frozen or not upgradeable. */
export async function getProgramUpgradeAuthority(
  rpc: Rpc<GetAccountInfoApi>,
  program: Address,
): Promise<{ upgradeable: boolean; authority: Address | null }> {
  const owner = await getProgramAuthority(rpc, program);
  return owner.programData ? { upgradeable: true, authority: owner.authority ?? null } : { upgradeable: false, authority: null };
}

export interface ProgramLinkInput {
  program: Address;
  appId: Address;
  /** Cluster of the App ID (the backlink names it). */
  cluster: Cluster;
  /** Signer for the upgrade authority: a wallet, a keypair, or a noop signer for a Squads vault. */
  authority: TransactionSigner;
  /** Pays rent; usually the same key as the authority. */
  payer: TransactionSigner;
}

/**
 * Build the instructions that make `program` point back to `appId`. Refuses programs that cannot carry a canonical
 * backlink (not upgradeable, or frozen) and signers that are not the upgrade authority, so the result never fails
 * onchain for those reasons.
 */
export async function getProgramLinkInstructions(
  rpc: Rpc<GetAccountInfoApi & GetMinimumBalanceForRentExemptionApi>,
  input: ProgramLinkInput,
): Promise<ProgramLinkPlan> {
  const { program, appId, cluster, authority, payer } = input;
  let owner: { authority?: Address; programData?: Address };
  try {
    owner = await getProgramAuthority(rpc, program);
  } catch (e) {
    throw new Error(`${program} is not a deployed program on this cluster (${(e as Error).message}).`);
  }
  if (!owner.programData) {
    throw new Error(`${program} is not an upgradeable program, so it cannot publish a canonical backlink. It needs an issuer attestation instead.`);
  }
  if (!owner.authority) {
    throw new Error(`${program} is immutable (no upgrade authority), so it cannot publish a canonical backlink. It needs an issuer attestation instead.`);
  }
  if (owner.authority !== authority.address) {
    throw new Error(`Only the upgrade authority ${owner.authority} can link ${program}; the signer is ${authority.address}.`);
  }

  const content = JSON.stringify(buildProgramLink(appId, cluster));
  const data = getUtf8Encoder().encode(content);
  const [metadata] = await findCanonicalPda({ program, seed: PROGRAM_METADATA_SEED });
  const fields = { encoding: Encoding.Utf8, compression: Compression.None, format: Format.Json, dataSource: DataSource.Direct } as const;
  const client = createClientWithGetMinimumBalanceFromRpc(rpc);
  const base = { program, programData: owner.programData, upgradeAuthority: owner.authority, metadata, content };

  const existing = await fetchMaybeMetadata(rpc, metadata, { commitment: 'confirmed' });
  if (!existing.exists) {
    const rentLamports = await client.getMinimumBalance(Number(getAccountSize(data.length)));
    const plan = await getCreateMetadataInstructionPlanUsingInstructionData(client, {
      metadata, authority, program, programData: owner.programData, seed: PROGRAM_METADATA_SEED, payer, data, ...fields,
    });
    return { ...strip(base), action: 'create', rentLamports, instructions: toInstructions(plan) };
  }

  const current = existing.data;
  const previous = readableContent(current);
  if (previous !== undefined && sameLink(previous, content)) {
    return { ...strip(base), action: 'unchanged', previous, rentLamports: 0n, instructions: [] };
  }
  if (!current.mutable) {
    throw new Error(`The oar backlink of ${program} is frozen${previous ? ` at ${previous}` : ''}; it cannot be changed.`);
  }
  const growth = data.length - current.data.length;
  const rentLamports = growth > 0 ? await client.getMinimumBalance(growth, { withoutHeader: true }) : 0n;
  const plan = await getUpdateMetadataInstructionPlanUsingInstructionData(client, {
    metadata: existing, authority, program, programData: owner.programData, payer, data, ...fields,
  });
  return { ...strip(base), action: 'update', previous, rentLamports, instructions: toInstructions(plan) };
}

function strip(b: { program: Address; programData: Address; upgradeAuthority: Address; metadata: Address; content: string }) {
  const { programData: _, ...rest } = b;
  return rest;
}

function toInstructions(plan: InstructionPlan): Instruction[] {
  return flattenInstructionPlan(plan).map(p => {
    if (p.kind !== 'single') throw new Error('Backlink content unexpectedly needs more than one transaction.');
    return p.instruction;
  });
}

/** Decode existing content for display, bounded so a hostile compressed account cannot balloon. */
function readableContent(d: { data: ReadonlyUint8Array; dataLength: number; compression: Compression; encoding: Encoding; dataSource: DataSource }): string | undefined {
  if (d.dataSource !== DataSource.Direct || d.dataLength > 1024) return undefined;
  try {
    const bytes = Uint8Array.from(d.data).slice(0, d.dataLength);
    return d.compression === Compression.None && d.encoding === Encoding.Utf8
      ? getUtf8Decoder().decode(bytes)
      : unpackDirectData({ data: bytes, compression: d.compression, encoding: d.encoding });
  } catch {
    return undefined;
  }
}

/**
 * Same app and cluster, whatever the key order or whitespace of the existing JSON. Parsed strictly: content the
 * verifier would reject (a repeated key) never counts as already linked.
 */
function sameLink(existing: string, wanted: string): boolean {
  try {
    const a = parseJsonStrict(existing) as Record<string, unknown>;
    const b = JSON.parse(wanted) as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(k => a[k] === b[k]);
  } catch {
    return false;
  }
}

/** What a program-link transaction does, in plain sentences, for a wallet screen or a multisig proposal. */
export function describeProgramLink(plan: ProgramLinkPlan, payer: Address): string[] {
  if (plan.action === 'unchanged') return [`${plan.program} already points to this App ID: ${plan.content}. Nothing to sign.`];
  const sol = (Number(plan.rentLamports) / 1e9).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  return [
    `${plan.action === 'create' ? 'Creates' : 'Rewrites'} the canonical "oar" Program Metadata account ${plan.metadata} of program ${plan.program}.`,
    `Content, stored onchain as plain JSON: ${plan.content}`,
    ...(plan.action === 'update' ? [`It replaces: ${plan.previous ?? 'content that could not be decoded'}`] : []),
    `Signed by the upgrade authority ${plan.upgradeAuthority}. It changes no program code and no authority.`,
    plan.rentLamports > 0n ? `Rent: ${sol} SOL from ${payer}, plus the network fee.` : `No extra rent; ${payer} pays only the network fee.`,
  ];
}

// ---------------------------------------------------------------------------
// Multisig export
// ---------------------------------------------------------------------------

/**
 * An unsigned transaction with `feePayer` (a Squads vault) as payer and signer, in the format the Program Metadata
 * CLI's `--export` produces, for importing into a multisig as a proposal. Signers still review the instructions.
 * Squads v3 accepts only legacy transactions.
 */
export function exportUnsignedTransaction(
  instructions: readonly Instruction[],
  feePayer: Address,
  latestBlockhash: { blockhash: Blockhash; lastValidBlockHeight: bigint },
  { version = 0 }: { version?: 0 | 'legacy' } = {},
): { base58: string; base64: string } {
  assertRegistrationInstructions(instructions);
  const message = pipe(
    createTransactionMessage({ version }),
    m => setTransactionMessageFeePayerSigner(createNoopSigner(feePayer), m),
    m => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const bytes = getTransactionEncoder().encode(compileTransaction(message));
  return { base58: getBase58Decoder().decode(bytes), base64: getBase64Decoder().decode(bytes) };
}

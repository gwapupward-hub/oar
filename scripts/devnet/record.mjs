// release/devnet.json state and the derived GWAP MASTER release record. Public data only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_FILE, readJson, root, writeJson } from './lib.mjs';

export const GWAP_RECORD_FILE = join(root, 'release', 'gwap-release-record.devnet.json');

/** NOT_READY -> PILOT (deployed, checks pending) -> DEVNET_VERIFIED (hash, IDL and smoke all verified). */
export function deriveStatus(r) {
  if (!r.deployment) return 'NOT_READY';
  if (r.deployment.hashVerified && r.idl?.verified && r.smoke?.pass) return 'DEVNET_VERIFIED';
  return 'PILOT';
}

export function blockers(r) {
  const out = [];
  if (!r.deployment) out.push('Program not deployed to devnet');
  else if (!r.deployment.hashVerified) out.push('Onchain executable hash not verified');
  if (!r.idl?.verified) out.push('IDL not published/verified via Program Metadata');
  if (!r.smoke?.pass) out.push('Devnet smoke suite not passed');
  return out;
}

/** GWAP MASTER schemas/release-record.schema.json shape (JSON is valid YAML for RELEASE_REGISTRY.yaml). */
export function gwapRecord(r) {
  const b = r.build ?? {};
  const d = r.deployment ?? {};
  const rec = {
    release_id: `oar-registry-devnet-${(b.repo_sha ?? 'unbuilt').slice(0, 12)}`,
    system: 'OAR',
    repo: 'gwapupward-hub/oar',
    repo_sha: b.repo_sha ?? '',
    environment: r.cluster,
    artifact: 'target/deploy/oar_registry.so',
    artifact_sha256: b.artifact_sha256 ?? '',
    tests: [
      b.ci_run_url && `CI ${b.ci_run_url}: rustfmt, clippy -D warnings, cargo test --locked, IDL drift, identical double build, SDK LiteSVM suite on this binary`,
      r.smoke?.evidence && `Devnet smoke ${r.smoke.pass ? 'passed' : 'FAILED'}: ${r.smoke.evidence}`,
    ].filter(Boolean),
    security_gates: [
      'Identity/secret source scan (scripts/check-release.mjs)',
      'Exposed reference program ID refused by source checks and CLI',
      'Program ID, upgrade authority and fee payer are distinct keys',
      'Independent security review: NOT DONE (mainnet gate)',
    ],
    deployed_target: d.programDataAddress ? `${r.programId} (ProgramData ${d.programDataAddress}, slot ${d.slot})` : '',
    deployed_hash: d.onchainExecutableHash ?? '',
    idl_or_interface_evidence: r.idl?.verified ? [`Program Metadata seed "idl" matches idl/oar_registry.json sha256 ${r.idl.sha256}`] : [],
    status: deriveStatus(r),
    blockers: blockers(r),
  };
  if (r.approvedBy) Object.assign(rec, { approved_by: r.approvedBy, approved_at: r.approvedAt });
  return rec;
}

export function loadRecord() {
  if (!existsSync(RELEASE_FILE)) throw new Error('release/devnet.json missing');
  return readJson(RELEASE_FILE);
}

export function saveRecord(r) {
  r.status = deriveStatus(r);
  writeJson(RELEASE_FILE, r);
  writeJson(GWAP_RECORD_FILE, gwapRecord(r));
}

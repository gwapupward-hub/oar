// Proof documents an app publishes about itself. Pure and free of Node APIs, so browser code can build them.
import type { Cluster } from './constants.js';

/** `/.well-known/oar.json` on a domain, or `oar.json` at a repository root. */
export interface ProofFile {
  oar: '0.1';
  apps: { app_id: string; cluster: Cluster }[];
}

/** Content of a program's canonical Program Metadata account, seed `oar`. */
export interface ProgramLink {
  oar: '0.1';
  app: string;
  cluster: Cluster;
}

export function buildProgramLink(appId: string, cluster: Cluster): ProgramLink {
  return { oar: '0.1', app: appId, cluster };
}

export function buildProofFile(apps: { appId: string; cluster: Cluster }[]): ProofFile {
  return { oar: '0.1', apps: apps.map(a => ({ app_id: a.appId, cluster: a.cluster })) };
}

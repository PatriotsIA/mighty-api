import type { CandidateProfile, CandidateRecord } from "./types";

export function toPublicCandidate(record: CandidateRecord): CandidateProfile {
  return { ...record.candidate };
}

export function toAdminCandidate(record: CandidateRecord): CandidateRecord {
  return structuredClone(record);
}

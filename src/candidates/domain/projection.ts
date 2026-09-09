import type { CandidateProfile, CandidateRecord } from "./types";

export function toPublicCandidate(record: CandidateRecord): CandidateProfile {
  return { ...record.candidate };
}

export function toAdminCandidate(record: CandidateRecord): Omit<CandidateRecord, "inputFingerprint"> {
  // Deliberate allowlist: adding a storage attribute must not add an API field.
  const { submissionId, candidate, source, consent, attestation, status, createdAt, updatedAt, statusUpdatedAt, revision, submitter, reviewer, reviewReason, changeRequest, lastChangeRequest } = record;
  return structuredClone({
    submissionId, candidate, source, consent, attestation, status, createdAt, updatedAt, statusUpdatedAt, revision,
    ...(submitter === undefined ? {} : { submitter }),
    ...(reviewer === undefined ? {} : { reviewer }),
    ...(reviewReason === undefined ? {} : { reviewReason }),
    ...(lastChangeRequest === undefined ? {} : { lastChangeRequest: {
      submissionId: lastChangeRequest.submissionId,
      appliedAt: lastChangeRequest.appliedAt,
      reviewer: lastChangeRequest.reviewer,
      previousRevision: lastChangeRequest.previousRevision,
    } }),
    ...(changeRequest === undefined ? {} : { changeRequest: {
      targetSubmissionId: changeRequest.targetSubmissionId,
      targetStatus: changeRequest.targetStatus,
      targetRevision: changeRequest.targetRevision,
      baseCandidate: changeRequest.baseCandidate,
      reason: changeRequest.reason,
    } }),
  });
}

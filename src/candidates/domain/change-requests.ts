import { createHash } from "node:crypto";
import type { CandidateRecord } from "./types";
import { changeTargetConflict, conflict } from "../lib/errors";

// Hash validated input, not the mutable review candidate or target. Object-key
// order is immaterial; array order and all supplied fields remain significant.
export function changeRequestFingerprint(input: object): string {
  const canonical = JSON.stringify(input, (_key, value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

// This is the intake receipt, never the current private moderation state.
export function changeRequestReceipt(record: CandidateRecord) {
  return { submissionId: record.submissionId, status: "pending" as const, createdAt: record.createdAt, revision: 1 };
}

// Only acceptance treats coverage as a set; intake retries retain exact arrays.
function candidateComparisonFingerprint(candidate: CandidateRecord["candidate"]) {
  return changeRequestFingerprint({ ...candidate, countySlugs: [...new Set(candidate.countySlugs || [])].sort() });
}

export function applyChangeRequestToTarget(request: CandidateRecord, target: CandidateRecord | undefined): CandidateRecord {
  const baseline = request.changeRequest;
  if (!baseline || !target || target.source === "change-request" || target.submissionId !== baseline.targetSubmissionId ||
      target.status !== baseline.targetStatus || target.revision !== baseline.targetRevision ||
      target.candidate.id !== baseline.baseCandidate.id || request.candidate.id !== baseline.baseCandidate.id) {
    throw changeTargetConflict();
  }
  if (candidateComparisonFingerprint(request.candidate) === candidateComparisonFingerprint(baseline.baseCandidate)) {
    throw conflict("NO_EFFECTIVE_CHANGE", "Edit the proposed candidate fields before approving; review notes alone do not change the profile");
  }
  return {
    ...target,
    candidate: structuredClone(request.candidate),
    updatedAt: request.updatedAt,
    revision: target.revision + 1,
    // Keep original moderation and consent provenance; acceptance is not a
    // publication decision, especially when the original is still pending.
    lastChangeRequest: { submissionId: request.submissionId, appliedAt: request.updatedAt, reviewer: request.reviewer!, previousRevision: target.revision },
  };
}

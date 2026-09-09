import {
  candidateProfileSchema,
  submitterSchema,
  type CandidatePatchInput,
  type SubmitterPatchInput,
} from "./schemas";
import type { CandidateRecord, CandidateStatus, Reviewer } from "./types";
import { ApiError, conflict } from "../lib/errors";
import { validationError } from "../lib/errors";

function assertRevision(record: CandidateRecord, expectedRevision: number): void {
  if (record.revision !== expectedRevision) {
    throw conflict("REVISION_CONFLICT", "The submission was changed by another request");
  }
}

function applyNullablePatch<T extends object>(current: T, patch: object): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(current as Record<string, unknown>) };

  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }

  return next;
}

export function patchCandidateProfile(record: CandidateRecord["candidate"], patch: CandidatePatchInput | undefined) {
  const parsed = candidateProfileSchema.safeParse(patch === undefined ? record : applyNullablePatch(record, patch));
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}

export function patchCandidateRecord(
  record: CandidateRecord,
  expectedRevision: number,
  candidatePatch: CandidatePatchInput | undefined,
  submitterPatch: SubmitterPatchInput | undefined,
  now: string,
  reviewReason?: string | null,
): CandidateRecord {
  assertRevision(record, expectedRevision);
  if (record.source === "change-request" && record.status !== "pending") {
    throw conflict("CHANGE_REQUEST_CLOSED", "Approved or denied change requests are read-only");
  }

  const candidate = patchCandidateProfile(record.candidate, candidatePatch);

  let submitter = record.submitter;
  if (submitterPatch !== undefined) {
    if (submitter === undefined) {
      throw new ApiError(409, "SUBMITTER_NOT_AVAILABLE", "Seeded candidates do not have submitter details");
    }
    submitter = submitterSchema.parse(applyNullablePatch(submitter, submitterPatch));
  }

  return {
    ...record,
    candidate,
    reviewReason: reviewReason === undefined ? record.reviewReason : reviewReason?.trim() || undefined,
    ...(submitter === undefined ? {} : { submitter }),
    updatedAt: now,
    revision: record.revision + 1,
  };
}

export function moderateCandidateRecord(
  record: CandidateRecord,
  decision: Exclude<CandidateStatus, "pending">,
  expectedRevision: number,
  reviewer: Reviewer,
  reason: string | undefined,
  now: string,
): CandidateRecord {
  assertRevision(record, expectedRevision);

  if (record.status !== "pending") {
    throw conflict(
      "INVALID_STATUS_TRANSITION",
      `A ${record.status} submission cannot transition to ${decision}`,
    );
  }

  const normalizedReason = reason?.trim();
  if (decision === "denied" && !normalizedReason) {
    throw new ApiError(400, "VALIDATION_ERROR", "A denial reason is required");
  }

  return {
    ...record,
    status: decision,
    updatedAt: now,
    statusUpdatedAt: now,
    revision: record.revision + 1,
    reviewer,
    ...(normalizedReason === undefined ? {} : { reviewReason: normalizedReason }),
  };
}

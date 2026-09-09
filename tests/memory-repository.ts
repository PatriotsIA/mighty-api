import type { CandidateRecord } from "../src/candidates/domain/types";
import type { AdminListOptions, PublicListOptions } from "../src/candidates/repository/candidates";
import { changeTargetConflict, conflict } from "../src/candidates/lib/errors";

// Test-only persistence adapter. Production always constructs DynamoDB storage.
export class MemoryRepository {
  records = new Map<string, CandidateRecord>();
  async create(record: CandidateRecord) {
    if (this.records.has(record.submissionId)) throw conflict("CANDIDATE_ID_EXISTS", "That candidate ID is already in use");
    this.records.set(record.submissionId, structuredClone(record));
  }
  async get(id: string) { return structuredClone(this.records.get(id)); }
  async save(record: CandidateRecord, revision: number) {
    if (this.records.get(record.submissionId)?.revision !== revision) throw conflict("REVISION_CONFLICT", "The submission was changed by another request");
    this.records.set(record.submissionId, structuredClone(record));
  }
  async applyChangeRequest(request: CandidateRecord, target: CandidateRecord, revision: number) {
    const currentRequest = this.records.get(request.submissionId);
    const currentTarget = this.records.get(target.submissionId);
    const baseline = request.changeRequest!;
    if (!currentRequest || currentRequest.revision !== revision || currentRequest.status !== "pending" || currentRequest.source !== "change-request" || currentRequest.candidate.id !== baseline.baseCandidate.id) throw conflict("REVISION_CONFLICT", "The submission was changed by another request");
    if (!currentTarget || currentTarget.revision !== baseline.targetRevision || currentTarget.status !== baseline.targetStatus || currentTarget.source === "change-request" || currentTarget.candidate.id !== baseline.baseCandidate.id) throw changeTargetConflict();
    // No awaits between either check and both writes. Clone both before writing
    // so a failed precondition (or cloning failure) cannot partially persist.
    const savedRequest = structuredClone(request);
    const savedTarget = structuredClone(target);
    this.records.set(request.submissionId, savedRequest);
    this.records.set(target.submissionId, savedTarget);
  }
  async listApproved(options: PublicListOptions) {
    return { items: [...this.records.values()].filter((record) => record.status === "approved" && record.source !== "change-request" && (!options.stateSlug || record.candidate.stateSlug === options.stateSlug) && (!options.countySlug || (record.candidate.countySlug === options.countySlug || record.candidate.countySlugs?.includes(options.countySlug) || record.candidate.scope === "statewide"))).map((record) => structuredClone(record)) };
  }
  async listAdmin(options: AdminListOptions) {
    return { items: [...this.records.values()].filter((record) => !options.status || record.status === options.status).map((record) => structuredClone(record)) };
  }
}

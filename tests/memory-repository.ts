import type { CandidateRecord } from "../src/candidates/domain/types";
import type { AdminListOptions, PublicListOptions } from "../src/candidates/repository/candidates";
import { conflict } from "../src/candidates/lib/errors";

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
  async listApproved(options: PublicListOptions) {
    return { items: [...this.records.values()].filter((record) => record.status === "approved" && (!options.stateSlug || record.candidate.stateSlug === options.stateSlug) && (!options.countySlug || record.candidate.countySlug === options.countySlug)).map((record) => structuredClone(record)) };
  }
  async listAdmin(options: AdminListOptions) {
    return { items: [...this.records.values()].filter((record) => !options.status || record.status === options.status).map((record) => structuredClone(record)) };
  }
}

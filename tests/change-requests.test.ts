import { describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createCandidateHandler } from "../src/candidates/handler";
import { applyChangeRequestToTarget } from "../src/candidates/domain/change-requests";
import type { CandidateRecord } from "../src/candidates/domain/types";
import { MemoryRepository } from "./memory-repository";

export function targetRecord(status: "pending" | "approved" | "denied" = "approved"): CandidateRecord {
  return {
    submissionId: "alex-example",
    candidate: { id: "alex-example", name: "Alex Example", office: "County Commissioner", stateSlug: "texas", scope: "county", countySlug: "potter", countyName: "Potter County", bio: "Original biography", websiteUrl: "https://example.com" },
    source: "submission", submitter: { submitterName: "Original staffer", submitterEmail: "original-private@example.com", submitterRole: "campaign" },
    consent: true, attestation: true, status, revision: 3,
    createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-08-25T12:00:00.000Z", statusUpdatedAt: "2026-08-25T12:00:00.000Z",
    reviewer: { sub: "original-reviewer" }, reviewReason: "Original verification notes",
  };
}

const requestBody = {
  requestId: "change-123", targetSubmissionId: "alex-example", targetStatus: "approved", expectedTargetRevision: 3,
  candidate: { bio: "Requested biography", websiteUrl: null }, reason: "Please correct the biography and remove the old website.",
  submitter: { submitterName: "Update staffer", submitterEmail: "update-private@example.com", submitterRole: "volunteer" },
  consent: true, attestation: true, honeypot: "",
};
function event(routeKey: string, body?: unknown, id = "alex-example", admin = false): APIGatewayProxyEventV2 {
  return { routeKey, body: body === undefined ? undefined : JSON.stringify(body), pathParameters: { submissionId: id, id },
    requestContext: { requestId: "change-test", authorizer: { jwt: { claims: admin ? { sub: "update-reviewer", "cognito:groups": "[admins]" } : {} } } },
  } as unknown as APIGatewayProxyEventV2;
}
function data(response: APIGatewayProxyStructuredResultV2) { return JSON.parse(response.body!).data; }
async function setup(status: "pending" | "approved" | "denied" = "approved") {
  const repository = new MemoryRepository();
  const original = targetRecord(status);
  await repository.create(original);
  const notify = vi.fn(async () => {});
  return { repository, original, notify, handler: createCandidateHandler(repository, { notify }) };
}

describe("change request intake", () => {
  it("accepts a narrative-only pending reference and captures its snapshot only for reviewers", async () => {
    const { repository, handler, original } = await setup("pending");
    const { candidate, expectedTargetRevision, ...common } = requestBody;
    const response = await handler(event("POST /v1/candidates/change-requests", { ...common, targetStatus: "pending" }));
    expect(response.statusCode).toBe(201);
    expect(data(response)).toEqual({ submissionId: "change-123", status: "pending", revision: 1, createdAt: expect.any(String) });
    expect(response.body).not.toContain("biography");
    const stored = await repository.get("change-123");
    expect(stored?.candidate).toEqual(original.candidate);
    expect(stored?.changeRequest).toEqual({ targetSubmissionId: original.submissionId, targetStatus: "pending", targetRevision: 3, baseCandidate: original.candidate, reason: requestBody.reason });
    expect(await repository.get(original.submissionId)).toEqual(original);
    expect(data(await handler(event("GET /v1/candidates")))).toEqual([]);
  });
  it("rejects any pending patch before reading the target, so validation cannot probe private fields", async () => {
    const { repository, handler } = await setup("pending");
    const get = vi.spyOn(repository, "get");
    for (const targetSubmissionId of ["alex-example", "missing-draft"]) {
      const response = await handler(event("POST /v1/candidates/change-requests", { ...requestBody, targetStatus: "pending", targetSubmissionId, candidate: { stateSlug: "alaska" } }));
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("Potter");
    }
    expect(get).not.toHaveBeenCalled();
  });
  it.each(["pending", "denied"] as const)("rejects an approved request when the actual target is %s", async (status) => {
    const { handler, repository, notify } = await setup(status);
    const response = await handler(event("POST /v1/candidates/change-requests", requestBody));
    expect(response.statusCode).toBe(status === "denied" ? 404 : 409);
    expect(await repository.get("change-123")).toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
    expect(response.body).not.toContain("Original");
  });
  it("rejects a stale approved revision without disclosing the target", async () => {
    const { handler } = await setup();
    const response = await handler(event("POST /v1/candidates/change-requests", { ...requestBody, expectedTargetRevision: 2 }));
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("Original");
  });
  it("rejects unknown or change-request references without creating another request", async () => {
    const { handler, repository } = await setup();
    expect((await handler(event("POST /v1/candidates/change-requests", { ...requestBody, targetSubmissionId: "missing" }))).statusCode).toBe(404);
    expect((await handler(event("POST /v1/candidates/change-requests", requestBody))).statusCode).toBe(201);
    expect((await handler(event("POST /v1/candidates/change-requests", { ...requestBody, requestId: "change-nested", targetSubmissionId: "change-123", targetStatus: "pending", candidate: undefined, expectedTargetRevision: undefined }))).statusCode).toBe(404);
    expect(repository.records.size).toBe(2);
  });
  it.each([
    { requestId: " Change-123 " }, { targetSubmissionId: "Alex-Example" }, { requestId: "../target" },
    { expectedTargetRevision: undefined }, { expectedTargetRevision: 0 }, { expectedTargetRevision: 1.5 },
    { candidate: { id: "changed-identity" } }, { candidate: {} }, { candidate: undefined },
    { candidate: { stateSlug: "alaska" } }, { reason: " " }, { reason: "x".repeat(2001) },
    { consent: false }, { attestation: false }, { honeypot: "bot" }, { submitter: undefined }, { source: "seed" },
  ])("rejects malformed change input %j", async (patch) => {
    const { handler, repository } = await setup();
    expect((await handler(event("POST /v1/candidates/change-requests", { ...requestBody, ...patch }))).statusCode).toBe(400);
    expect(repository.records.size).toBe(1);
  });
  it("stores an approved-profile proposal and immutable baseline privately without changing the target", async () => {
    const { repository, handler, original, notify } = await setup();
    const response = await handler(event("POST /v1/candidates/change-requests", requestBody));
    expect(response.statusCode).toBe(201);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    const stored = await repository.get("change-123");
    expect(data(response)).toEqual({ submissionId: "change-123", status: "pending", revision: 1, createdAt: stored?.createdAt });
    expect(stored).toMatchObject({ submissionId: "change-123", source: "change-request", status: "pending", candidate: { id: original.candidate.id, bio: "Requested biography" }, submitter: requestBody.submitter, consent: true, attestation: true,
      changeRequest: { targetSubmissionId: "alex-example", targetStatus: "approved", targetRevision: 3, baseCandidate: original.candidate, reason: requestBody.reason } });
    expect(stored?.candidate).not.toHaveProperty("websiteUrl");
    expect(await repository.get("alex-example")).toEqual(original);
    expect(notify).toHaveBeenCalledExactlyOnceWith(stored);
    expect((await handler(event("GET /v1/admin/candidates/{submissionId}", undefined, "change-123"))).statusCode).toBe(403);
    const privateResponse = await handler(event("GET /v1/admin/candidates/{submissionId}", undefined, "change-123", true));
    expect(data(privateResponse).changeRequest.baseCandidate).toEqual(original.candidate);
    expect(data(privateResponse).source).toBe("change-request");
    expect(data(await handler(event("GET /v1/candidates")))).toEqual([original.candidate]);
    expect((await handler(event("GET /v1/candidates/{id}", undefined, "change-123"))).statusCode).toBe(404);
  });
});

describe("change request retries and private projection", () => {
  it("keeps county array order significant for retries under the same request ID", async () => {
    const { handler, repository, notify } = await setup();
    const input = { ...requestBody, candidate: { countySlugs: ["randall", "carson"] } };
    const first = await handler(event("POST /v1/candidates/change-requests", input));
    expect(first.statusCode).toBe(201);
    const stored = await repository.get(input.requestId);
    const identical = await handler(event("POST /v1/candidates/change-requests", input));
    expect(identical.statusCode).toBe(200);
    expect(data(identical)).toEqual(data(first));
    const reordered = await handler(event("POST /v1/candidates/change-requests", { ...input, candidate: { countySlugs: ["carson", "randall"] } }));
    expect(reordered.statusCode).toBe(409);
    expect(JSON.parse(reordered.body!).error.code).toBe("CANDIDATE_ID_EXISTS");
    expect(await repository.get(input.requestId)).toStrictEqual(stored);
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it.each(["edited", "deleted"])("recovers the winning receipt when a concurrent identical create precedes a %s target read", async (change) => {
    const { handler, repository, original, notify } = await setup();
    const get = repository.get.bind(repository);
    let winningReceipt: unknown;
    vi.spyOn(repository, "get").mockImplementationOnce(async (id) => {
      const absent = await get(id);
      expect(absent).toBeUndefined();
      const winner = await handler(event("POST /v1/candidates/change-requests", requestBody));
      expect(winner.statusCode).toBe(201);
      winningReceipt = data(winner);
      if (change === "deleted") repository.records.delete(original.submissionId);
      else await repository.save({ ...original, revision: 4, candidate: { ...original.candidate, bio: "Concurrent original edit" } }, 3);
      return absent;
    });
    const response = await handler(event("POST /v1/candidates/change-requests", requestBody));
    expect(response.statusCode).toBe(200);
    expect(data(response)).toEqual(winningReceipt);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await repository.get("change-123"))?.changeRequest?.targetRevision).toBe(3);
  });
  it("returns the original receipt after review edits and target changes with no duplicate mail", async () => {
    const { handler, repository, notify } = await setup();
    const first = await handler(event("POST /v1/candidates/change-requests", requestBody));
    expect(first.statusCode).toBe(201);
    expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { bio: "Reviewer corrected biography" } }, "change-123", true))).statusCode).toBe(200);
    expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 3, candidate: { office: "Updated office" } }, "alex-example", true))).statusCode).toBe(200);
    const retry = await handler(event("POST /v1/candidates/change-requests", { ...requestBody, candidate: { websiteUrl: null, bio: "Requested biography" } }));
    expect(retry.statusCode).toBe(200);
    expect(data(retry)).toEqual(data(first));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(repository.records.size).toBe(2);
    expect((await repository.get("change-123"))?.candidate.bio).toBe("Reviewer corrected biography");
    expect((await handler(event("POST /v1/candidates/change-requests", { ...requestBody, reason: "Different request" }))).statusCode).toBe(409);
  });
  it("coalesces two simultaneous identical submissions and never overwrites an occupied ID", async () => {
    const { handler, repository, original, notify } = await setup();
    const responses = await Promise.all([handler(event("POST /v1/candidates/change-requests", requestBody)), handler(event("POST /v1/candidates/change-requests", requestBody))]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(data(responses[0])).toEqual(data(responses[1]));
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await handler(event("POST /v1/candidates/change-requests", { ...requestBody, requestId: original.submissionId }))).statusCode).toBe(409);
    expect(await repository.get(original.submissionId)).toEqual(original);
    for (const route of ["POST /v1/candidates/submissions", "POST /v1/admin/candidates"]) {
      const body = route.includes("admin") ? { candidate: { ...original.candidate, id: "change-123" }, reviewReason: "Research" } : { candidate: { ...original.candidate, id: "change-123" }, submitter: requestBody.submitter, consent: true, attestation: true };
      expect((await handler(event(route, body, "change-123", true))).statusCode).toBe(409);
    }
    expect(repository.records.size).toBe(2);
  });
  it("whitelists admin list/get fields, retaining request source/baseline but not stored fingerprints", async () => {
    const { handler, repository } = await setup();
    await handler(event("POST /v1/candidates/change-requests", requestBody));
    const stored = (await repository.get("change-123"))!;
    expect(stored.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    repository.records.set("change-123", { ...stored, internalFutureField: "sensitive-internal", changeRequest: { ...stored.changeRequest!, internalNested: "sensitive-nested" } } as CandidateRecord);
    for (const route of ["GET /v1/admin/candidates", "GET /v1/admin/candidates/{submissionId}"]) {
      const response = await handler(event(route, undefined, "change-123", true));
      expect(response.statusCode).toBe(200);
      expect(response.headers?.["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("inputFingerprint");
      expect(response.body).not.toContain(stored.inputFingerprint);
      expect(response.body).not.toContain("sensitive-");
      const request = route.endsWith("}") ? data(response) : data(response).find((record: CandidateRecord) => record.source === "change-request");
      expect(request.changeRequest).toEqual(stored.changeRequest);
    }
  });
});

describe("change request review", () => {
  it("saves proposal edits and review notes without mutating the target or baseline", async () => {
    const { repository, handler, original } = await setup("pending");
    await handler(event("POST /v1/candidates/change-requests", { ...requestBody, targetStatus: "pending", candidate: undefined, expectedTargetRevision: undefined }));
    const before = (await repository.get("change-123"))!;
    const response = await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { bio: "Reviewer entered narrative corrections" }, reviewReason: "  Verified with official source  " }, "change-123", true));
    expect(response.statusCode).toBe(200);
    expect(data(response)).toMatchObject({ revision: 2, status: "pending", reviewReason: "Verified with official source", candidate: { bio: "Reviewer entered narrative corrections" }, changeRequest: before.changeRequest });
    expect(response.body).not.toContain("inputFingerprint");
    expect(await repository.get(original.submissionId)).toEqual(original);
    expect(data(await handler(event("GET /v1/candidates")))).toEqual([]);
    expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, reviewReason: "Stale notes" }, "change-123", true))).statusCode).toBe(409);
    const cleared = await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 2, reviewReason: null }, "change-123", true));
    expect(cleared.statusCode).toBe(200);
    expect(data(cleared)).not.toHaveProperty("reviewReason");
    expect((await repository.get("change-123"))?.inputFingerprint).toBe(before.inputFingerprint);
  });
  it("supports revision-checked note-only patches to published originals", async () => {
    const { handler, original, repository } = await setup();
    const response = await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 3, reviewReason: "Updated verification notes" }, original.submissionId, true));
    expect(response.statusCode).toBe(200);
    expect(await repository.get(original.submissionId)).toMatchObject({ ...original, revision: 4, updatedAt: expect.any(String), reviewReason: "Updated verification notes" });
  });
});

describe("change request acceptance", () => {
  it.each([
    { status: "approved", source: "submission" },
    { status: "pending", source: "research" },
    { status: "approved", source: "seed" },
  ] as const)("applies a reviewed change to $source/$status without replacing original metadata or publishing drafts", async ({ status, source }) => {
    const { repository, handler } = await setup(status);
    const original = { ...targetRecord(status), source, ...(source === "submission" ? {} : { consent: false, attestation: false, submitter: undefined }) };
    repository.records.set(original.submissionId, structuredClone(original));
    const input = status === "approved" ? requestBody : { ...requestBody, targetStatus: "pending", expectedTargetRevision: undefined, candidate: undefined };
    const receipt = await handler(event("POST /v1/candidates/change-requests", input));
    expect(receipt.statusCode).toBe(201);
    const before = (await repository.get("change-123"))!;
    expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { bio: "Final verified biography" }, reviewReason: "Verified correction sources" }, "change-123", true))).statusCode).toBe(200);
    const response = await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 2 }, "change-123", true));
    expect(response.statusCode).toBe(200);
    const request = (await repository.get("change-123"))!;
    const target = (await repository.get(original.submissionId))!;
    expect(request).toMatchObject({ source: "change-request", status: "approved", revision: 3, reviewer: { sub: "update-reviewer" }, reviewReason: "Verified correction sources", changeRequest: before.changeRequest, inputFingerprint: before.inputFingerprint });
    expect(target).toEqual({ ...original, candidate: request.candidate, revision: 4, updatedAt: request.updatedAt,
      lastChangeRequest: { submissionId: request.submissionId, appliedAt: request.updatedAt, reviewer: request.reviewer, previousRevision: 3 } });
    expect(target.candidate.id).toBe(original.candidate.id);
    expect(target.lastChangeRequest?.reviewer.sub).toBe("update-reviewer");
    expect(data(await handler(event("GET /v1/admin/candidates/{submissionId}", undefined, original.submissionId, true))).lastChangeRequest).toEqual(target.lastChangeRequest);
    expect(data(response)).not.toHaveProperty("inputFingerprint");
    expect(data(await handler(event("POST /v1/candidates/change-requests", input)))).toEqual(data(receipt));
    for (const route of ["GET /v1/candidates/{id}", "GET /v1/candidates/{id}/change-target"]) {
      expect((await handler(event(route, undefined, "change-123"))).statusCode).toBe(404);
    }
    const published = data(await handler(event("GET /v1/candidates")));
    expect(published).toEqual(status === "approved" ? [target.candidate] : []);
    expect((await handler(event("GET /v1/candidates/{id}", undefined, original.submissionId))).statusCode).toBe(status === "approved" ? 200 : 404);
    const approvedQuery = event("GET /v1/admin/candidates", undefined, "change-123", true);
    approvedQuery.queryStringParameters = { status: "approved" };
    expect(data(await handler(approvedQuery)).filter((record: CandidateRecord) => record.source !== "change-request")).toHaveLength(status === "approved" ? 1 : 0);
  });
});

describe("change request safety", () => {
  it("rejects saved county reordering and review notes without accepting the pending request", async () => {
    const { repository, handler, original } = await setup("pending");
    original.candidate.countySlugs = ["randall", "carson"];
    repository.records.set(original.submissionId, structuredClone(original));
    expect((await handler(event("POST /v1/candidates/change-requests", { ...requestBody, targetStatus: "pending", candidate: undefined, expectedTargetRevision: undefined }))).statusCode).toBe(201);
    expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { countySlugs: ["carson", "randall"] }, reviewReason: "Only review notes changed" }, "change-123", true))).statusCode).toBe(200);
    const before = await repository.get("change-123");
    const response = await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 2 }, "change-123", true));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body!).error.code).toBe("NO_EFFECTIVE_CHANGE");
    expect(await repository.get(original.submissionId)).toStrictEqual(original);
    expect(await repository.get("change-123")).toStrictEqual(before);
  });
  it.each(["pending", "approved"] as const)("requires effective candidate edits before accepting a %s request", async (status) => {
    const { repository, handler, original } = await setup(status);
    const input = { ...requestBody, targetStatus: status, candidate: status === "approved" ? { bio: original.candidate.bio } : undefined, expectedTargetRevision: status === "approved" ? 3 : undefined };
    expect((await handler(event("POST /v1/candidates/change-requests", input))).statusCode).toBe(201);
    expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, reviewReason: "Notes do not change the profile" }, "change-123", true))).statusCode).toBe(200);
    const before = await repository.get("change-123");
    const response = await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 2 }, "change-123", true));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body!).error).toMatchObject({ code: "NO_EFFECTIVE_CHANGE", message: expect.stringMatching(/edit/i) });
    expect(await repository.get(original.submissionId)).toEqual(original);
    expect(await repository.get("change-123")).toEqual(before);
  });
  it.each(["approve", "deny"])("makes a request read-only after %s and rejects repeated decisions without modifying the target", async (decision) => {
    const { repository, handler, original } = await setup();
    const receipt = await handler(event("POST /v1/candidates/change-requests", requestBody));
    const response = await handler(event(`POST /v1/admin/candidates/{submissionId}/${decision}`, { expectedRevision: 1, reason: "Reviewed decision" }, "change-123", true));
    expect(response.statusCode).toBe(200);
    const target = await repository.get(original.submissionId);
    const request = await repository.get("change-123");
    if (decision === "deny") expect(target).toEqual(original);
    for (const candidate of [{ bio: "A closed request edit" }, undefined]) {
      expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 2, candidate, reviewReason: "No more notes" }, "change-123", true))).statusCode).toBe(409);
    }
    for (const next of ["approve", "deny"]) {
      for (const expectedRevision of [1, 2]) {
        expect((await handler(event(`POST /v1/admin/candidates/{submissionId}/${next}`, { expectedRevision, reason: "Retry" }, "change-123", true))).statusCode).toBe(409);
      }
    }
    expect(await repository.get(original.submissionId)).toEqual(target);
    expect(await repository.get("change-123")).toEqual(request);
    expect(data(await handler(event("POST /v1/candidates/change-requests", requestBody)))).toEqual(data(receipt));
  });
  it("does not allow public or reviewer patches to alter request identity, baseline or status", async () => {
    const { repository, handler } = await setup();
    await handler(event("POST /v1/candidates/change-requests", requestBody));
    const before = await repository.get("change-123");
    for (const patch of [{ candidate: { id: "override" } }, { changeRequest: { targetSubmissionId: "override" } }, { status: "approved" }, { source: "research" }, { inputFingerprint: "override" }, { consent: false }]) {
      expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, ...patch }, "change-123", true))).statusCode).toBe(400);
    }
    expect(await repository.get("change-123")).toEqual(before);
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/deny", { expectedRevision: 1, reason: " " }, "change-123", true))).statusCode).toBe(400);
  });
});

describe("county coverage semantic comparison", () => {
  it.each([
    { label: "reject reordered coverage", baseline: ["randall", "carson"], proposed: ["carson", "randall"], effective: false },
    { label: "reject duplicate proposed coverage", baseline: ["randall", "carson"], proposed: ["carson", "randall", "carson"], effective: false },
    { label: "reject deduplicated baseline coverage", baseline: ["randall", "carson", "randall"], proposed: ["carson", "randall"], effective: false },
    { label: "reject absent-to-empty coverage", baseline: undefined, proposed: [], effective: false },
    { label: "reject empty-to-absent coverage", baseline: [], proposed: undefined, effective: false },
    { label: "accept an added county without reordering", baseline: ["randall"], proposed: ["randall", "carson"], effective: true },
    { label: "accept a removed county", baseline: ["randall", "carson"], proposed: ["randall"], effective: true },
  ])("$label without mutating inputs or publishing the original", ({ baseline, proposed, effective }) => {
    const target = targetRecord("pending");
    if (baseline !== undefined) target.candidate.countySlugs = baseline;
    const candidate = { ...target.candidate, countySlugs: proposed };
    if (proposed === undefined) delete candidate.countySlugs;
    // Duplicate arrays model stored legacy values, not a relaxation of intake validation.
    const request: CandidateRecord = { ...target, submissionId: "change-county-set", source: "change-request", status: "approved", candidate,
      updatedAt: "2026-08-26T12:00:00.000Z", reviewer: { sub: "update-reviewer" },
      changeRequest: { targetSubmissionId: target.submissionId, targetStatus: "pending", targetRevision: target.revision, baseCandidate: structuredClone(target.candidate), reason: "Correct county coverage" } };
    const before = structuredClone({ request, target });
    if (effective) {
      const applied = applyChangeRequestToTarget(request, target);
      expect(applied).toStrictEqual({ ...target, candidate: request.candidate, updatedAt: request.updatedAt, revision: target.revision + 1,
        lastChangeRequest: { submissionId: request.submissionId, appliedAt: request.updatedAt, reviewer: request.reviewer, previousRevision: target.revision } });
      expect(applied.status).toBe("pending");
      expect(applied.candidate).not.toBe(request.candidate);
      expect(applied.candidate.countySlugs).not.toBe(request.candidate.countySlugs);
    } else {
      expect(() => applyChangeRequestToTarget(request, target)).toThrowError(expect.objectContaining({ code: "NO_EFFECTIVE_CHANGE" }));
    }
    expect({ request, target }).toStrictEqual(before);
  });
});

describe("stale targets and reviewer races", () => {
  it.each(["edited", "approved", "denied", "deleted", "replaced"])("rejects a %s target with actionable 409 and keeps the request pending", async (change) => {
    const { handler, repository, original } = await setup("pending");
    await handler(event("POST /v1/candidates/change-requests", { ...requestBody, targetStatus: "pending", candidate: undefined, expectedTargetRevision: undefined }));
    await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { bio: "Reviewed update" } }, "change-123", true));
    if (change === "deleted") repository.records.delete(original.submissionId);
    else repository.records.set(original.submissionId, { ...original, ...(change === "edited" ? { revision: 4, candidate: { ...original.candidate, bio: "Concurrent edit" } } : change === "replaced" ? { source: "change-request" as const } : { status: change as "approved" | "denied" }) });
    const targetBefore = await repository.get(original.submissionId);
    const requestBefore = await repository.get("change-123");
    const apply = vi.spyOn(repository, "applyChangeRequest");
    const response = await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 2 }, "change-123", true));
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body!).error).toMatchObject({ code: "CHANGE_TARGET_CONFLICT", message: expect.stringMatching(/open the original.*compare.*manually.*deny.*resubmit/i) });
    expect(apply).not.toHaveBeenCalled();
    expect(await repository.get("change-123")).toEqual(requestBefore);
    expect(await repository.get(original.submissionId)).toEqual(targetBefore);
    // Staleness never blocks denial or makes it alter the target.
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/deny", { expectedRevision: 2, reason: "Stale; resubmit after comparison" }, "change-123", true))).statusCode).toBe(200);
    expect(await repository.get(original.submissionId)).toEqual(targetBefore);
  });
  it("refuses corrupt proposed identities before any transaction", async () => {
    const { handler, repository, original } = await setup();
    await handler(event("POST /v1/candidates/change-requests", requestBody));
    const request = (await repository.get("change-123"))!;
    repository.records.set(request.submissionId, { ...request, candidate: { ...request.candidate, id: "override" } });
    const apply = vi.spyOn(repository, "applyChangeRequest");
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }, "change-123", true))).statusCode).toBe(409);
    expect(apply).not.toHaveBeenCalled();
    expect(await repository.get(original.submissionId)).toEqual(original);
  });
  it.each(["approve", "deny", "edit"])("allows only one winner when approval races a second reviewer %s", async (other) => {
    const { handler, repository, original } = await setup();
    await handler(event("POST /v1/candidates/change-requests", requestBody));
    const second = other === "edit" ? event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { bio: "Second reviewer edit" } }, "change-123", true) : event(`POST /v1/admin/candidates/{submissionId}/${other}`, { expectedRevision: 1, reason: "Second decision" }, "change-123", true);
    const results = await Promise.all([handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }, "change-123", true)), handler(second)]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const request = (await repository.get("change-123"))!;
    const target = (await repository.get(original.submissionId))!;
    expect(request.revision).toBe(2);
    if (request.status === "approved") expect(target).toMatchObject({ candidate: request.candidate, revision: 4 });
    else expect(target).toEqual(original);
  });
  it("allows only one of two requests sharing a baseline to apply", async () => {
    const { handler, repository, original } = await setup();
    await handler(event("POST /v1/candidates/change-requests", requestBody));
    await handler(event("POST /v1/candidates/change-requests", { ...requestBody, requestId: "change-other", candidate: { bio: "Another proposal" } }));
    const results = await Promise.all(["change-123", "change-other"].map((id) => handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }, id, true))));
    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const requests = await Promise.all([repository.get("change-123"), repository.get("change-other")]);
    expect(requests.filter((request) => request?.status === "approved")).toHaveLength(1);
    expect(requests.filter((request) => request?.status === "pending")).toHaveLength(1);
    expect(await repository.get(original.submissionId)).toMatchObject({ revision: 4, candidate: requests.find((request) => request?.status === "approved")?.candidate });
  });
  it("catches a target edit between the handler read and the atomic write without partially approving", async () => {
    const { handler, repository, original } = await setup();
    await handler(event("POST /v1/candidates/change-requests", requestBody));
    const requestBefore = await repository.get("change-123");
    const apply = repository.applyChangeRequest.bind(repository);
    vi.spyOn(repository, "applyChangeRequest").mockImplementationOnce(async (...args) => {
      await repository.save({ ...original, revision: 4, candidate: { ...original.candidate, bio: "Won the race" } }, 3);
      return apply(...args);
    });
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }, "change-123", true))).statusCode).toBe(409);
    expect(await repository.get("change-123")).toEqual(requestBefore);
    expect(await repository.get(original.submissionId)).toMatchObject({ revision: 4, candidate: { bio: "Won the race" } });
  });
});

describe("reference routing boundaries", () => {
  it("allows the full request ID length to be privately retrieved and reviewed", async () => {
    const { handler } = await setup();
    const requestId = "c".repeat(100);
    expect((await handler(event("POST /v1/candidates/change-requests", { ...requestBody, requestId }))).statusCode).toBe(201);
    expect((await handler(event("GET /v1/admin/candidates/{submissionId}", undefined, requestId, true))).statusCode).toBe(200);
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/deny", { expectedRevision: 1, reason: "Reviewed" }, requestId, true))).statusCode).toBe(200);
  });
  it.each(["Alex-Example", " alex-example ", "../alex-example"])("rejects malformed change-target reference %s before lookup instead of repairing it", async (id) => {
    const { handler, repository } = await setup();
    const get = vi.spyOn(repository, "get");
    expect((await handler(event("GET /v1/candidates/{id}/change-target", undefined, id))).statusCode).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("public change target", () => {
  it("returns only an approved profile and its optimistic reference, without caching", async () => {
    const { handler, original } = await setup();
    const response = await handler(event("GET /v1/candidates/{id}/change-target"));
    expect(response.statusCode).toBe(200);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(data(response)).toEqual({ candidate: original.candidate, submissionId: original.submissionId, revision: 3, status: "approved" });
    expect(response.body).not.toContain("private");
  });
  it.each(["pending", "denied"] as const)("does not expose a %s profile", async (status) => {
    const { handler } = await setup(status);
    const response = await handler(event("GET /v1/candidates/{id}/change-target"));
    expect(response.statusCode).toBe(404);
    expect(response.headers?.["cache-control"]).toBe("no-store");
    expect(response.body).not.toContain("Original");
  });
});

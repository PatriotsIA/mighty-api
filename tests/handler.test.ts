import { describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createCandidateHandler } from "../src/candidates/handler";
import { MemoryRepository } from "./memory-repository";

const submission = { candidate: { id: "alex-example", name: "Alex Example", office: "County Commissioner", stateSlug: "texas", countySlug: "potter", countyName: "Potter County", scope: "county" }, submitter: { submitterName: "Private Staffer", submitterEmail: "private@example.com", submitterRole: "campaign" }, consent: true, attestation: true };
function event(routeKey: string, body?: unknown, admin = false) {
  return { routeKey, body: body === undefined ? undefined : JSON.stringify(body), pathParameters: { submissionId: "alex-example", id: "alex-example" }, requestContext: { requestId: "test", authorizer: { jwt: { claims: admin ? { sub: "reviewer", "cognito:groups": "[admins]" } : {} } } } } as unknown as APIGatewayProxyEventV2;
}

describe("submission through real handler and moderation", () => {
  it("persists privately, edits with revisions, approves, and publishes only public fields", async () => {
    const repository = new MemoryRepository();
    const notify = vi.fn(async () => {});
    const handler = createCandidateHandler(repository, { notify });
    expect((await handler(event("POST /v1/candidates/submissions", submission))).statusCode).toBe(201);
    expect(JSON.parse((await handler(event("GET /v1/candidates"))).body!).data).toEqual([]);
    expect((await handler(event("GET /v1/candidates/{id}"))).statusCode).toBe(404);
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }))).statusCode).toBe(403);
    const updated = await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { bio: "Reviewed biography" } }, true));
    expect(updated.statusCode).toBe(200);
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }, true))).statusCode).toBe(409);
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 2 }, true))).statusCode).toBe(200);
    const published = await handler(event("GET /v1/candidates"));
    const profiles = JSON.parse(published.body!).data;
    expect(profiles).toHaveLength(1);
    expect(profiles[0].bio).toBe("Reviewed biography");
    expect(published.body).not.toContain("private@example.com");
    expect(profiles[0]).not.toHaveProperty("revision");
    expect(notify).toHaveBeenCalledTimes(1);
  });
  it("returns a receipt on an identical retry without duplicate records or notifications", async () => {
    const repository = new MemoryRepository();
    const notify = vi.fn(async () => {});
    const handler = createCandidateHandler(repository, { notify });
    await handler(event("POST /v1/candidates/submissions", submission));
    const retried = await handler(event("POST /v1/candidates/submissions", submission));
    expect(retried.statusCode).toBe(200);
    expect(repository.records.size).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await handler(event("POST /v1/candidates/submissions", { ...submission, submitter: { ...submission.submitter, submitterEmail: "different@example.com" } }))).statusCode).toBe(409);
  });
  it("keeps a durable receipt when notifications fail and rejects invalid geography", async () => {
    const handler = createCandidateHandler(new MemoryRepository(), { notify: async () => { throw new Error("SES down"); } });
    expect((await handler(event("POST /v1/candidates/submissions", submission))).statusCode).toBe(201);
    expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { stateSlug: "alaska" } }, true))).statusCode).toBe(400);
    expect((await handler(event("POST /v1/candidates/submissions", { ...submission, candidate: { ...submission.candidate, stateSlug: "not-a-state" } }))).statusCode).toBe(400);
  });
  it("denies a submission without publishing it", async () => {
    const handler = createCandidateHandler(new MemoryRepository(), { notify: async () => {} });
    await handler(event("POST /v1/candidates/submissions", submission));
    expect((await handler(event("POST /v1/admin/candidates/{submissionId}/deny", { expectedRevision: 1, reason: "Unable to verify" }, true))).statusCode).toBe(200);
    expect(JSON.parse((await handler(event("GET /v1/candidates"))).body!).data).toEqual([]);
  });
});

it("creates authenticated research drafts privately without consent claims or notification, and enforces county boundaries", async () => {
  const repository = new MemoryRepository();
  const notify = vi.fn(async () => {});
  const handler = createCandidateHandler(repository, { notify });
  const draft = { candidate: { ...submission.candidate, officeLevel: "federal", scope: "district", countySlugs: ["randall"] }, reviewReason: "Verified election filing and official biography; prepared for review." };
  expect((await handler(event("POST /v1/admin/candidates", draft))).statusCode).toBe(403);
  expect((await handler(event("POST /v1/admin/candidates", draft, true))).statusCode).toBe(201);
  expect((await handler(event("POST /v1/admin/candidates", draft, true))).statusCode).toBe(200);
  expect(repository.records.size).toBe(1);
  expect(repository.records.get("alex-example")).toMatchObject({ source: "research", consent: false, attestation: false, status: "pending" });
  expect(notify).not.toHaveBeenCalled();
  expect(JSON.parse((await handler(event("GET /v1/candidates"))).body!).data).toEqual([]);
  expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { countySlugs: ["cook"] } }, true))).statusCode).toBe(400);
  expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }, true))).statusCode).toBe(200);
  const query = event("GET /v1/candidates");
  query.queryStringParameters = { stateSlug: "texas", countySlug: "randall" };
  expect(JSON.parse((await handler(query)).body!).data).toHaveLength(1);
  query.queryStringParameters = { stateSlug: "texas", countySlug: "travis" };
  expect(JSON.parse((await handler(query)).body!).data).toEqual([]);
  query.queryStringParameters = { countySlug: "randall" };
  expect((await handler(query)).statusCode).toBe(400);
  expect((await handler(event("POST /v1/admin/candidates", { ...draft, candidate: { ...draft.candidate, name: "Overwrite attempt" } }, true))).statusCode).toBe(409);
});

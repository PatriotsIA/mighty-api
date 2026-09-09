import { Buffer } from "node:buffer";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createCandidateHandler } from "../src/candidates/handler";
import type { CandidateRecord } from "../src/candidates/domain/types";
import { CandidateRepository } from "../src/candidates/repository/candidates";

function original(id: string, updatedAt: string, profile: Partial<CandidateRecord["candidate"]> = {}): CandidateRecord {
  return {
    submissionId: id,
    candidate: { id, name: id, office: "Commissioner", stateSlug: "texas", scope: "county", countySlug: "potter", ...profile },
    source: "seed", consent: false, attestation: false, status: "approved", revision: 1,
    createdAt: "2026-08-01T00:00:00.000Z", statusUpdatedAt: "2026-08-02T00:00:00.000Z", updatedAt,
  };
}
function acceptedRequest(id: string, target: CandidateRecord, updatedAt: string): CandidateRecord {
  return {
    ...target, submissionId: id, source: "change-request", status: "approved", updatedAt,
    changeRequest: { targetSubmissionId: target.submissionId, targetStatus: target.status as "pending" | "approved", targetRevision: 1, baseCandidate: target.candidate, reason: "Private request instructions" },
  };
}
function indexKey(record: CandidateRecord) {
  return { submissionId: record.submissionId, status: record.status, updatedAt: record.updatedAt };
}

// Model the DynamoDB boundary, not the repository: Limit/size evaluation happens
// before filtering, and a full table + GSI key resumes after the evaluated row.
// Equal-sort-key rows use one stable allowed order; the repository must not sort
// them itself or resume by timestamp alone.
function indexedRepository(records: CandidateRecord[], evaluatedPageCap = Infinity) {
  const rows = records.filter((record) => record.status === "approved")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.submissionId.localeCompare(b.submissionId));
  const send = vi.fn(async (command: QueryCommand) => {
    expect(command).toBeInstanceOf(QueryCommand);
    const input = command.input;
    expect(input.IndexName).toBe("StatusUpdatedAtIndex");
    expect(input.ScanIndexForward).toBe(false);
    expect(input.KeyConditionExpression).toBe("#status = :approved");
    expect(input.FilterExpression).toContain("(attribute_not_exists(#source) OR #source <> :changeRequest)");
    const values = input.ExpressionAttributeValues!;
    expect(values[":approved"]).toBe("approved");
    expect(values[":changeRequest"]).toBe("change-request");
    if (values[":stateSlug"]) expect(input.FilterExpression).toContain("#candidate.#stateSlug = :stateSlug");
    if (values[":countySlug"]) expect(input.FilterExpression).toContain("(#candidate.#countySlug = :countySlug OR contains(#candidate.#countySlugs, :countySlug) OR #candidate.#scope = :statewide)");
    const anchor = input.ExclusiveStartKey;
    const anchorIndex = anchor ? rows.findIndex((row) => row.submissionId === anchor.submissionId) : -1;
    if (anchor) {
      expect(anchorIndex).toBeGreaterThanOrEqual(0);
      expect(anchor).toEqual(indexKey(rows[anchorIndex]));
    }
    const evaluatedLimit = Math.min(input.Limit!, evaluatedPageCap);
    const evaluated = rows.slice(anchorIndex + 1, anchorIndex + 1 + evaluatedLimit);
    const items = evaluated.filter((record) => record.source !== "change-request"
      && (!values[":stateSlug"] || record.candidate.stateSlug === values[":stateSlug"])
      && (!values[":countySlug"] || record.candidate.countySlug === values[":countySlug"]
        || record.candidate.countySlugs?.includes(values[":countySlug"]) || record.candidate.scope === "statewide"));
    return {
      Items: items,
      // DynamoDB may still return a key at the end of a full evaluated page.
      ...(evaluated.length === evaluatedLimit ? { LastEvaluatedKey: indexKey(evaluated[evaluated.length - 1]) } : {}),
    };
  });
  const repository = new CandidateRepository("candidate-table", { send } as unknown as DynamoDBDocumentClient);
  return { repository, send, handler: createCandidateHandler(repository, { notify: vi.fn() }) };
}
function listEvent(query: Record<string, string>): APIGatewayProxyEventV2 {
  return { routeKey: "GET /v1/candidates", queryStringParameters: query, requestContext: { requestId: "pagination-test" } } as unknown as APIGatewayProxyEventV2;
}

const alex = original("alex-example", "2026-09-10T00:00:00.000Z");
const alaska = original("alaska-original", "2026-09-08T00:00:00.000Z", { stateSlug: "alaska", countySlug: undefined, scope: "statewide" });
const randall = original("randall-original", "2026-09-07T00:00:00.000Z", { countySlug: "randall" });
const district = original("multi-county-original", "2026-09-05T00:00:00.000Z", { scope: "district", countySlug: "randall", countySlugs: ["potter"] });
const statewide = original("statewide-original", "2026-09-05T00:00:00.000Z", { scope: "statewide", countySlug: undefined });
const legacy = original("legacy-original", "2026-09-04T00:00:00.000Z");
// Existing source-less originals remain public under attribute_not_exists.
Reflect.deleteProperty(legacy, "source");
const pending = { ...original("still-pending-original", "2026-09-01T00:00:00.000Z"), status: "pending" as const };
const rows = [
  acceptedRequest("change-private-leading", pending, "2026-09-12T00:00:00.000Z"),
  alex,
  acceptedRequest("change-shared-timestamp", alex, alex.updatedAt),
  acceptedRequest("change-private-middle", pending, "2026-09-09T00:00:00.000Z"),
  alaska, randall, district, statewide, legacy,
  acceptedRequest("change-private-trailing", pending, "2026-09-03T00:00:00.000Z"),
  acceptedRequest("change-private-final", alex, "2026-09-02T00:00:00.000Z"),
  pending,
];
const filters: { query: Record<string, string>; expected: CandidateRecord[] }[] = [
  { query: {}, expected: [alex, alaska, randall, district, statewide, legacy] },
  { query: { stateSlug: "texas" }, expected: [alex, randall, district, statewide, legacy] },
  { query: { stateSlug: "texas", countySlug: "potter" }, expected: [alex, district, statewide, legacy] },
  { query: { stateSlug: "florida" }, expected: [] },
];

describe("public HTTP pagination with the real DynamoDB repository", () => {
  it.each([1, 2, 3, 100])("preserves every eligible original exactly once through mixed/empty pages with limit %i", async (limit) => {
    for (const { query, expected } of filters) {
      // Cap evaluated rows to also exercise short DynamoDB size-limited pages.
      const { handler } = indexedRepository(rows, 2);
      const received: string[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await handler(listEvent({ ...query, limit: String(limit), ...(cursor ? { cursor } : {}) }));
        expect(response.statusCode).toBe(200);
        const page = JSON.parse(response.body!);
        expect(page.data.length).toBeLessThanOrEqual(limit);
        received.push(...page.data.map((candidate: { id: string }) => candidate.id));
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          expect(page.data).toHaveLength(limit);
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
          expect(cursors.size).toBeLessThan(rows.length);
          const lastReturned = expected.find((record) => record.candidate.id === page.data[page.data.length - 1].id)!;
          expect(lastReturned).toBeDefined();
          expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))).toEqual(indexKey(lastReturned));
        }
      } while (cursor !== undefined);
      expect(received).toEqual(expected.map((record) => record.candidate.id));
      expect(new Set(received).size).toBe(received.length);
    }
  });

  it("does not reveal accepted requests against a still-pending original, even through limit=1 continuation", async () => {
    const privateRows = rows.filter((record) => record.changeRequest?.targetStatus === "pending" || record.status === "pending");
    const { handler, send } = indexedRepository(privateRows);
    const response = await handler(listEvent({ limit: "1" }));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ data: [] });
    expect(send.mock.calls.length).toBeGreaterThan(1);
    const emptyResponse = await indexedRepository([]).handler(listEvent({ limit: "1" }));
    expect(response.body).toBe(emptyResponse.body);
  });

  it("does not advertise more public results when only private requests remain after a full page", async () => {
    const { handler } = indexedRepository([alex, ...rows.filter((record) => record.submissionId.startsWith("change-private-t") || record.submissionId === "change-private-final")]);
    const response = await handler(listEvent({ limit: "1" }));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body!)).toEqual({ data: [alex.candidate] });
  });

  it.each([
    { submissionId: "change-private", status: "pending", updatedAt: "private-time" },
    { submissionId: "change-private" },
    { submissionId: "change-private", status: "approved", updatedAt: "private-time", source: "change-request" },
  ])("retains fail-closed public cursor validation for %j", async (key) => {
    const { handler, send } = indexedRepository(rows);
    const response = await handler(listEvent({ limit: "1", cursor: Buffer.from(JSON.stringify(key)).toString("base64url") }));
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body!).error.code).toBe("INVALID_CURSOR");
    expect(send).not.toHaveBeenCalled();
  });
});

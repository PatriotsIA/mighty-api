import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { CandidateRepository } from "../src/candidates/repository/candidates";
import type { CandidateRecord } from "../src/candidates/domain/types";

function transactionRecords() {
  const target: CandidateRecord = {
    submissionId: "alex-example", candidate: { id: "alex-example", name: "Alex Example", office: "Commissioner", stateSlug: "texas", scope: "county", countySlug: "potter", bio: "Original" },
    source: "seed", consent: false, attestation: false, status: "approved", revision: 4,
    createdAt: "2026-08-24T12:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z", statusUpdatedAt: "2026-08-24T12:00:00.000Z",
  };
  const request: CandidateRecord = {
    ...target, submissionId: "change-123", source: "change-request", status: "approved", revision: 2,
    candidate: { ...target.candidate, bio: "Revised" }, reviewer: { sub: "reviewer" },
    changeRequest: { targetSubmissionId: target.submissionId, targetStatus: "approved", targetRevision: 3, baseCandidate: target.candidate, reason: "Correction" },
  };
  return { request, target: { ...target, candidate: request.candidate } };
}
function setup() {
  const send = vi.fn<(command: unknown) => Promise<any>>(async () => ({}));
  const repository = new CandidateRepository("candidate-table", { send } as unknown as DynamoDBDocumentClient);
  return { send, repository };
}

describe("DynamoDB public/private list contracts", () => {
  it.each([{}, { stateSlug: "texas" }, { stateSlug: "texas", countySlug: "potter" }])("always excludes request records in public index queries while preserving filters %j", async (filters) => {
    const { repository, send } = setup();
    await repository.listApproved({ limit: 20, ...filters });
    const command = send.mock.calls[0][0] as QueryCommand;
    expect(command).toBeInstanceOf(QueryCommand);
    expect(command.input.IndexName).toBe("StatusUpdatedAtIndex");
    expect(command.input.KeyConditionExpression).toBe("#status = :approved");
    expect(command.input.FilterExpression).toContain("(attribute_not_exists(#source) OR #source <> :changeRequest)");
    expect(command.input.ExpressionAttributeNames?.["#source"]).toBe("source");
    expect(command.input.ExpressionAttributeValues?.[":changeRequest"]).toBe("change-request");
    expect(command.input.Limit).toBe(20);
    if ("stateSlug" in filters) expect(command.input.FilterExpression).toContain("#candidate.#stateSlug = :stateSlug");
    if ("countySlug" in filters) expect(command.input.FilterExpression).toContain("(#candidate.#countySlug = :countySlug OR contains(#candidate.#countySlugs, :countySlug) OR #candidate.#scope = :statewide)");
  });
  it("drains request-only public pages internally without exposing private continuation keys", async () => {
    const { repository, send } = setup();
    const key = { submissionId: "change-123", status: "approved", updatedAt: "2026-09-09T12:00:00.000Z" };
    send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: key });
    send.mockResolvedValueOnce({ Items: [] });
    const page = await repository.listApproved({ limit: 1 });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual(key);
  });
  it("anchors public continuation to the last returned original rather than a mixed page's hidden boundary", async () => {
    const { repository, send } = setup();
    const { target, request } = transactionRecords();
    const second: CandidateRecord = { ...target, submissionId: "second-original", candidate: { ...target.candidate, id: "second-original" }, updatedAt: "2026-09-07T12:00:00.000Z" };
    const third: CandidateRecord = { ...target, submissionId: "third-original", candidate: { ...target.candidate, id: "third-original" }, updatedAt: "2026-09-06T12:00:00.000Z" };
    const privateKey = { submissionId: request.submissionId, status: "approved", updatedAt: "2026-09-08T12:00:00.000Z" };
    const publicKey = { submissionId: second.submissionId, status: "approved", updatedAt: second.updatedAt };
    send.mockResolvedValueOnce({ Items: [target], LastEvaluatedKey: privateKey });
    send.mockResolvedValueOnce({ Items: [second, third] });
    const page = await repository.listApproved({ limit: 2 });
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"))).toEqual(publicKey);
    expect(page.items).toEqual([target, second]);
    expect((send.mock.calls[1][0] as QueryCommand).input.ExclusiveStartKey).toEqual(privateKey);

    // Lookahead must be re-read on continuation, not silently consumed.
    send.mockResolvedValueOnce({ Items: [third] });
    expect(await repository.listApproved({ limit: 2, cursor: page.nextCursor })).toEqual({ items: [third] });
    expect((send.mock.calls[2][0] as QueryCommand).input.ExclusiveStartKey).toEqual(publicKey);
  });
  it("treats an empty DynamoDB key as exhaustion instead of restarting the index", async () => {
    const { repository, send } = setup();
    const { target } = transactionRecords();
    send.mockResolvedValue({ Items: [target], LastEvaluatedKey: {} });
    expect(await repository.listApproved({ limit: 1 })).toEqual({ items: [target] });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "pending", "approved"] as const)("keeps requests in the private %s queue", async (status) => {
    const { repository, send } = setup();
    const { request } = transactionRecords();
    const key = status === undefined ? { submissionId: request.submissionId } : { submissionId: request.submissionId, status, updatedAt: request.updatedAt };
    send.mockResolvedValueOnce({ Items: [request], LastEvaluatedKey: key });
    const page = await repository.listAdmin({ status, limit: 50 });
    expect(page.items).toEqual([request]);
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"))).toEqual(key);
    const command = send.mock.calls[0][0] as QueryCommand | ScanCommand;
    expect(command).toBeInstanceOf(status ? QueryCommand : ScanCommand);
    expect(command.input.FilterExpression).toBeUndefined();
  });
});

describe("atomic DynamoDB change acceptance", () => {
  it.each([
    { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }], code: "REVISION_CONFLICT" },
    { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "ConditionalCheckFailed" }], code: "CHANGE_TARGET_CONFLICT" },
    { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }], code: "CHANGE_TARGET_CONFLICT" },
    { name: "TransactionCanceledException", code: "CHANGE_TARGET_CONFLICT" },
    { name: "TransactionConflictException", code: "CHANGE_TARGET_CONFLICT" },
  ])("turns concurrency failure $name/$code into 409 without a non-atomic fallback", async ({ code, ...details }) => {
    const { send, repository } = setup();
    send.mockRejectedValueOnce(Object.assign(new Error("DynamoDB race"), details));
    const { request, target } = transactionRecords();
    await expect(repository.applyChangeRequest(request, target, 1)).rejects.toMatchObject({ statusCode: 409, code });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not disguise infrastructure errors as optimistic conflicts", async () => {
    const { send, repository } = setup();
    const error = Object.assign(new Error("Capacity exhausted"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }] });
    send.mockRejectedValueOnce(error);
    const { request, target } = transactionRecords();
    await expect(repository.applyChangeRequest(request, target, 1)).rejects.toBe(error);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("uses one transaction with conditional puts checking both revisions, statuses and identities", async () => {
    const { repository, send } = setup();
    const { request, target } = transactionRecords();
    await repository.applyChangeRequest(request, target, 1);
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const puts = command.input.TransactItems?.map((item) => item.Put);
    expect(puts).toHaveLength(2);
    expect(puts?.map((put) => put?.Item)).toEqual([request, target]);
    expect(puts?.map((put) => put?.TableName)).toEqual(["candidate-table", "candidate-table"]);
    for (const [index, put] of puts!.entries()) {
      expect(put?.ConditionExpression).toContain("attribute_exists(submissionId)");
      expect(put?.ConditionExpression).toContain("#revision = :expectedRevision");
      expect(put?.ConditionExpression).toContain("#status = :expectedStatus");
      expect(put?.ConditionExpression).toContain("#candidate.#id = :candidateId");
      expect(put?.ExpressionAttributeNames).toMatchObject({ "#revision": "revision", "#status": "status", "#source": "source", "#candidate": "candidate", "#id": "id" });
      expect(put?.ExpressionAttributeValues).toMatchObject({ ":expectedRevision": index === 0 ? 1 : 3, ":expectedStatus": index === 0 ? "pending" : "approved", ":changeRequest": "change-request", ":candidateId": "alex-example" });
    }
    expect(puts?.[0]?.ConditionExpression).toContain("#source = :changeRequest");
    expect(puts?.[1]?.ConditionExpression).toContain("#source <> :changeRequest");
  });
});

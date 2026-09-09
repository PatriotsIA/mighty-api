import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";

import type { CandidateRecord, CandidateStatus, Page } from "../domain/types";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { changeTargetConflict, conflict } from "../lib/errors";

const STATUS_UPDATED_AT_INDEX = "StatusUpdatedAtIndex";

type DocumentClient = DynamoDBDocumentClient;

function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

export interface PublicListOptions {
  stateSlug?: string;
  countySlug?: string;
  limit: number;
  cursor?: string;
}

export interface AdminListOptions {
  status?: CandidateStatus;
  limit: number;
  cursor?: string;
}

export class CandidateRepository {
  private readonly client: DocumentClient;

  public constructor(
    private readonly tableName: string,
    client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  ) {
    this.client = client;
  }

  public async create(record: CandidateRecord): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          ConditionExpression: "attribute_not_exists(submissionId)",
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw conflict("CANDIDATE_ID_EXISTS", "That candidate ID is already in use");
      }
      throw error;
    }
  }

  public async get(submissionId: string): Promise<CandidateRecord | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { submissionId },
        ConsistentRead: true,
      }),
    );

    return result.Item as CandidateRecord | undefined;
  }

  public async save(record: CandidateRecord, expectedRevision: number): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          ConditionExpression: "attribute_exists(submissionId) AND #revision = :expectedRevision",
          ExpressionAttributeNames: {
            "#revision": "revision",
          },
          ExpressionAttributeValues: {
            ":expectedRevision": expectedRevision,
          },
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw conflict("REVISION_CONFLICT", "The submission was changed by another request");
      }
      throw error;
    }
  }

  public async applyChangeRequest(request: CandidateRecord, target: CandidateRecord, expectedRevision: number): Promise<void> {
    const baseline = request.changeRequest!;
    try {
      await this.client.send(new TransactWriteCommand({
      TransactItems: [
        { Put: {
          TableName: this.tableName,
          Item: request,
          ConditionExpression: "attribute_exists(submissionId) AND #revision = :expectedRevision AND #status = :expectedStatus AND #source = :changeRequest AND #candidate.#id = :candidateId",
          ExpressionAttributeNames: { "#revision": "revision", "#status": "status", "#source": "source", "#candidate": "candidate", "#id": "id" },
          ExpressionAttributeValues: { ":expectedRevision": expectedRevision, ":expectedStatus": "pending", ":changeRequest": "change-request", ":candidateId": baseline.baseCandidate.id },
        } },
        { Put: {
          TableName: this.tableName,
          Item: target,
          ConditionExpression: "attribute_exists(submissionId) AND #revision = :expectedRevision AND #status = :expectedStatus AND #source <> :changeRequest AND #candidate.#id = :candidateId",
          ExpressionAttributeNames: { "#revision": "revision", "#status": "status", "#source": "source", "#candidate": "candidate", "#id": "id" },
          ExpressionAttributeValues: { ":expectedRevision": baseline.targetRevision, ":expectedStatus": baseline.targetStatus, ":changeRequest": "change-request", ":candidateId": baseline.baseCandidate.id },
        } },
      ],
      }));
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === "TransactionConflictException") throw changeTargetConflict();
        if (error.name === "TransactionCanceledException") {
          const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
          if (reasons?.[0]?.Code === "ConditionalCheckFailed") {
            throw conflict("REVISION_CONFLICT", "The submission was changed by another request");
          }
          // Some SDK/service responses omit cancellation details. Fail closed
          // as a conflict; never fall back to independent writes. Explicit
          // capacity/validation failures below still propagate as server errors.
          if (!reasons?.length || reasons.some((reason) => reason.Code === "ConditionalCheckFailed" || reason.Code === "TransactionConflict")) throw changeTargetConflict();
        }
      }
      throw error;
    }
  }

  public async listApproved(options: PublicListOptions): Promise<Page<CandidateRecord>> {
    let exclusiveStartKey: Record<string, unknown> | undefined = decodeCursor(options.cursor, "index", "approved");
    const expressionNames: Record<string, string> = {
      "#status": "status",
      "#source": "source",
    };
    const expressionValues: Record<string, unknown> = {
      ":approved": "approved",
      ":changeRequest": "change-request",
    };
    const filters = ["(attribute_not_exists(#source) OR #source <> :changeRequest)"];

    if (options.stateSlug !== undefined) {
      expressionNames["#candidate"] = "candidate";
      expressionNames["#stateSlug"] = "stateSlug";
      expressionValues[":stateSlug"] = options.stateSlug;
      filters.push("#candidate.#stateSlug = :stateSlug");
    }
    if (options.countySlug !== undefined) {
      expressionNames["#candidate"] = "candidate";
      expressionNames["#countySlug"] = "countySlug";
      expressionValues[":countySlug"] = options.countySlug;
      expressionNames["#countySlugs"] = "countySlugs";
      expressionNames["#scope"] = "scope";
      expressionValues[":statewide"] = "statewide";
      filters.push("(#candidate.#countySlug = :countySlug OR contains(#candidate.#countySlugs, :countySlug) OR #candidate.#scope = :statewide)");
    }

    const items: CandidateRecord[] = [];
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: STATUS_UPDATED_AT_INDEX,
          KeyConditionExpression: "#status = :approved",
          ExpressionAttributeNames: expressionNames,
          ExpressionAttributeValues: expressionValues,
          FilterExpression: filters.join(" AND "),
          Limit: options.limit,
          ScanIndexForward: false,
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );

      items.push(...((result.Items ?? []) as CandidateRecord[]));
      if (items.length > options.limit) {
        // Look ahead to an eligible original so hidden rows alone never create
        // public continuation. Re-read that lookahead on the next request by
        // anchoring only to the last returned original's full table/GSI key.
        const lastReturned = items[options.limit - 1]!;
        return {
          items: items.slice(0, options.limit),
          nextCursor: encodeCursor({
            submissionId: lastReturned.submissionId,
            status: "approved",
            updatedAt: lastReturned.updatedAt,
          }),
        };
      }
      // DynamoDB applies filters after Limit/1 MB evaluation. Its boundary may
      // identify a private request, even with no Items; keep it server-side.
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined && Object.keys(exclusiveStartKey).length > 0);

    return { items };
  }

  public async listAdmin(options: AdminListOptions): Promise<Page<CandidateRecord>> {
    const exclusiveStartKey = decodeCursor(
      options.cursor,
      options.status === undefined ? "table" : "index",
      options.status,
    );

    if (options.status !== undefined) {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: STATUS_UPDATED_AT_INDEX,
          KeyConditionExpression: "#status = :status",
          ExpressionAttributeNames: {
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":status": options.status,
          },
          Limit: options.limit,
          ScanIndexForward: false,
          ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
        }),
      );
      const nextCursor = encodeCursor(result.LastEvaluatedKey);
      return {
        items: (result.Items ?? []) as CandidateRecord[],
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    }

    const result = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        Limit: options.limit,
        ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
      }),
    );
    const nextCursor = encodeCursor(result.LastEvaluatedKey);
    return {
      items: (result.Items ?? []) as CandidateRecord[],
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
}

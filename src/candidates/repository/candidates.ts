import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import type { CandidateRecord, CandidateStatus, Page } from "../domain/types";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { conflict } from "../lib/errors";

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

  public async listApproved(options: PublicListOptions): Promise<Page<CandidateRecord>> {
    const exclusiveStartKey = decodeCursor(options.cursor, "index", "approved");
    const expressionNames: Record<string, string> = {
      "#status": "status",
    };
    const expressionValues: Record<string, unknown> = {
      ":approved": "approved",
    };
    const filters: string[] = [];

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

    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: STATUS_UPDATED_AT_INDEX,
        KeyConditionExpression: "#status = :approved",
        ExpressionAttributeNames: expressionNames,
        ExpressionAttributeValues: expressionValues,
        ...(filters.length === 0 ? {} : { FilterExpression: filters.join(" AND ") }),
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

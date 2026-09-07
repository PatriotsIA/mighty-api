import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

import { candidateProfileSchema } from "../src/candidates/domain/schemas";
import type { CandidateRecord } from "../src/candidates/domain/types";

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) {
    return process.argv[index + 1];
  }
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}

async function main(): Promise<void> {
  const seedPath = resolve(process.cwd(), "seed/candidates.json");
  const candidates = candidateProfileSchema.array().parse(
    JSON.parse(await readFile(seedPath, "utf8")) as unknown,
  );
  const dryRun = process.argv.includes("--dry-run");
  const tableName = optionValue("--table") ?? process.env.CANDIDATES_TABLE_NAME;

  if (dryRun) {
    console.info(`Validated ${candidates.length} candidates; no records written`);
    return;
  }
  if (!tableName) {
    throw new Error("Set CANDIDATES_TABLE_NAME or pass --table <name>");
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const now = new Date().toISOString();
  let inserted = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const record: CandidateRecord = {
      submissionId: candidate.id,
      candidate,
      consent: false,
      attestation: false,
      source: "seed",
      status: "approved",
      createdAt: now,
      updatedAt: now,
      statusUpdatedAt: now,
      revision: 1,
      reviewer: {
        sub: "system:seed",
        username: "seed-command",
      },
      reviewReason: "Imported from the checked-in candidate catalog",
    };

    try {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: record,
          ConditionExpression: "attribute_not_exists(submissionId)",
        }),
      );
      inserted += 1;
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }

  console.info(`Seed complete: ${inserted} inserted, ${skipped} already existed`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown seed failure";
  console.error(`Seed failed: ${message}`);
  process.exitCode = 1;
});

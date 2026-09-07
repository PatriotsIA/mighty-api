import { ApiError } from "./errors";

export type PaginationKey = Record<string, string>;
export type CursorKind = "index" | "table";

export function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (key === undefined) {
    return undefined;
  }

  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function decodeCursor(
  cursor: string | undefined,
  kind: CursorKind,
  expectedStatus?: string,
): PaginationKey | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Cursor is not an object");
    }

    const entries = Object.entries(parsed);
    const expectedKeys =
      kind === "index"
        ? new Set(["submissionId", "status", "updatedAt"])
        : new Set(["submissionId"]);
    const parsedRecord = parsed as Record<string, unknown>;
    if (
      entries.length !== expectedKeys.size ||
      entries.some(([key, value]) => !expectedKeys.has(key) || typeof value !== "string") ||
      typeof parsedRecord.submissionId !== "string" ||
      (expectedStatus !== undefined && parsedRecord.status !== expectedStatus)
    ) {
      throw new Error("Cursor has invalid keys");
    }

    return Object.fromEntries(entries) as PaginationKey;
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "The pagination cursor is invalid");
  }
}

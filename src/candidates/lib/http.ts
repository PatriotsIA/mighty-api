import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { ZodType } from "zod";

import { ApiError, validationError } from "./errors";

// Twenty bounded questionnaire answers plus the existing profile fields.
const MAX_BODY_BYTES = 128 * 1024;

export function jsonResponse(
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

export function parseJsonBody<T>(event: APIGatewayProxyEventV2, schema: ZodType<T>, maxBodyBytes = MAX_BODY_BYTES): T {
  if (!event.body) {
    throw new ApiError(400, "INVALID_JSON", "A JSON request body is required");
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  if (Buffer.byteLength(rawBody, "utf8") > maxBodyBytes) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "The request body is too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON");
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw validationError(result.error);
  }

  return result.data;
}

export function errorResponse(error: ApiError, requestId: string): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(
    error.statusCode,
    {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    },
    { "cache-control": "no-store" },
  );
}

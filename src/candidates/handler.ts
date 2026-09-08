import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import type { ZodType } from "zod";

import { moderateCandidateRecord, patchCandidateRecord } from "./domain/moderation";
import { toAdminCandidate, toPublicCandidate } from "./domain/projection";
import {
  adminListQuerySchema,
  adminPatchSchema,
  approveSchema,
  candidateIdSchema,
  candidateProfileSchema,
  candidateSubmissionSchema,
  denySchema,
  publicListQuerySchema,
  researchDraftSchema,
} from "./domain/schemas";
import type { CandidateRecord, Reviewer } from "./domain/types";
import { ApiError, notFound, validationError } from "./lib/errors";
import { errorResponse, jsonResponse, parseJsonBody } from "./lib/http";
import { errorName, logger } from "./lib/logger";
import { CandidateRepository } from "./repository/candidates";
import { SubmissionEmailService } from "./services/submission-email";
import { CandidatePhotoStore, photoIdSchema, photoUploadSchema } from "./services/photos";

const adminGroup = process.env.ADMIN_GROUP ?? "admins";

type Claims = Record<string, unknown>;

function parseWithSchema<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(result.error);
  }
  return result.data;
}

function pathIdentifier(event: APIGatewayProxyEventV2, key: "id" | "submissionId"): string {
  return parseWithSchema(candidateIdSchema, event.pathParameters?.[key]);
}

function getClaims(event: APIGatewayProxyEventV2): Claims {
  const requestContext = event.requestContext as unknown as {
    authorizer?: { jwt?: { claims?: Claims } };
  };
  return requestContext.authorizer?.jwt?.claims ?? {};
}

function groupValues(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // API Gateway can expose this claim as a plain string instead of JSON.
  }

  const unwrapped =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return unwrapped
    .split(",")
    .map((group) => group.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function assertAdmin(event: APIGatewayProxyEventV2): Reviewer {
  const claims = getClaims(event);
  if (!groupValues(claims["cognito:groups"]).includes(adminGroup)) {
    throw new ApiError(403, "ADMIN_GROUP_REQUIRED", "Administrator access is required");
  }

  const sub = claims.sub;
  if (typeof sub !== "string" || sub.length === 0) {
    throw new ApiError(403, "INVALID_ADMIN_TOKEN", "The administrator token is missing a subject");
  }

  const username = claims["cognito:username"];
  const email = claims.email;
  return {
    sub,
    ...(typeof username === "string" && username.length > 0 ? { username } : {}),
    ...(typeof email === "string" && email.length > 0 ? { email } : {}),
  };
}

function generateCandidateId(name: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "candidate";

  return `${base}-${randomUUID().slice(0, 8)}`;
}

export function createCandidateHandler(
  repository: Pick<CandidateRepository, "create" | "get" | "save" | "listApproved" | "listAdmin">,
  emailService: Pick<SubmissionEmailService, "notify">,
  photos: Pick<CandidatePhotoStore, "create" | "get"> = new CandidatePhotoStore(process.env.CANDIDATE_PHOTOS_BUCKET ?? ""),
) {
  async function getRecord(submissionId: string): Promise<CandidateRecord> {
    const record = await repository.get(submissionId);
    if (record === undefined) {
      throw notFound();
    }
    return record;
  }

  async function createSubmission(
    event: APIGatewayProxyEventV2,
    requestId: string,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const input = parseJsonBody(event, candidateSubmissionSchema);
    const candidate = candidateProfileSchema.parse({
      ...input.candidate,
      id: input.candidate.id ?? generateCandidateId(input.candidate.name),
    });
    const now = new Date().toISOString();
    const record: CandidateRecord = {
      submissionId: candidate.id,
      candidate,
      submitter: input.submitter,
      consent: input.consent,
      attestation: input.attestation,
      source: "submission",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      statusUpdatedAt: now,
      revision: 1,
    };

    try {
      await repository.create(record);
    } catch (error) {
      // A browser can lose the response after persistence. Its stable candidate
      // ID lets an identical retry receive a receipt without another record/email.
      if (!(error instanceof ApiError) || error.code !== "CANDIDATE_ID_EXISTS" || !input.candidate.id) throw error;
      const existing = await repository.get(record.submissionId);
      if (!existing || existing.source !== "submission" ||
          !isDeepStrictEqual(existing.candidate, record.candidate) ||
          !isDeepStrictEqual(existing.submitter, record.submitter) ||
          existing.consent !== record.consent || existing.attestation !== record.attestation) throw error;
      return jsonResponse(200, { data: { submissionId: existing.submissionId, status: existing.status, createdAt: existing.createdAt, revision: existing.revision } }, { "cache-control": "no-store" });
    }

    try {
      await emailService.notify(record);
    } catch (error) {
      logger.warn("submission_notification_failed", {
        requestId,
        errorName: errorName(error),
      });
    }

    return jsonResponse(
      201,
      {
        data: {
          submissionId: record.submissionId,
          status: record.status,
          createdAt: record.createdAt,
          revision: record.revision,
        },
      },
      {
        location: `/v1/admin/candidates/${record.submissionId}`,
        "cache-control": "no-store",
      },
    );
  }

  async function listPublic(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const query = parseWithSchema(publicListQuerySchema, event.queryStringParameters ?? {});
    const page = await repository.listApproved(query);
    return jsonResponse(
      200,
      {
        data: page.items.map(toPublicCandidate),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
      { "cache-control": "public, max-age=60" },
    );
  }

  async function getPublic(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const record = await repository.get(pathIdentifier(event, "id"));
    if (record === undefined || record.status !== "approved") {
      throw notFound("Approved candidate not found");
    }

    return jsonResponse(200, { data: toPublicCandidate(record) }, { "cache-control": "public, max-age=60" });
  }

  async function listAdmin(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const query = parseWithSchema(adminListQuerySchema, event.queryStringParameters ?? {});
    const page = await repository.listAdmin(query);
    return jsonResponse(
      200,
      {
        data: page.items.map(toAdminCandidate),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      },
      { "cache-control": "no-store" },
    );
  }

  async function getAdmin(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const record = await getRecord(pathIdentifier(event, "submissionId"));
    return jsonResponse(200, { data: toAdminCandidate(record) }, { "cache-control": "no-store" });
  }

  async function patchAdmin(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const input = parseJsonBody(event, adminPatchSchema);
    const record = await getRecord(pathIdentifier(event, "submissionId"));
    const updated = patchCandidateRecord(
      record,
      input.expectedRevision,
      input.candidate,
      input.submitter,
      new Date().toISOString(),
    );
    await repository.save(updated, input.expectedRevision);
    return jsonResponse(200, { data: toAdminCandidate(updated) }, { "cache-control": "no-store" });
  }

  async function moderateAdmin(
    event: APIGatewayProxyEventV2,
    reviewer: Reviewer,
    decision: "approved" | "denied",
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const input =
      decision === "approved"
        ? parseJsonBody(event, approveSchema)
        : parseJsonBody(event, denySchema);
    const record = await getRecord(pathIdentifier(event, "submissionId"));
    const updated = moderateCandidateRecord(
      record,
      decision,
      input.expectedRevision,
      reviewer,
      input.reason,
      new Date().toISOString(),
    );
    await repository.save(updated, input.expectedRevision);
    return jsonResponse(200, { data: toAdminCandidate(updated) }, { "cache-control": "no-store" });
  }

  async function route(
    event: APIGatewayProxyEventV2,
    requestId: string,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const reviewer = event.routeKey.startsWith("GET /v1/admin/") ||
      event.routeKey.startsWith("PATCH /v1/admin/") ||
      event.routeKey.startsWith("POST /v1/admin/")
      ? assertAdmin(event)
      : undefined;

    switch (event.routeKey) {
      case "POST /v1/admin/candidates": {
        const input = parseJsonBody(event, researchDraftSchema);
        const now = new Date().toISOString();
        const record: CandidateRecord = { submissionId: input.candidate.id, candidate: input.candidate, source: "research", consent: false, attestation: false, status: "pending", createdAt: now, updatedAt: now, statusUpdatedAt: now, revision: 1, reviewer, reviewReason: input.reviewReason };
        try { await repository.create(record); }
        catch (error) {
          if (!(error instanceof ApiError) || error.code !== "CANDIDATE_ID_EXISTS") throw error;
          const existing = await repository.get(record.submissionId);
          if (!existing || existing.source !== "research" || !isDeepStrictEqual(existing.candidate, record.candidate)) throw error;
          return jsonResponse(200, { data: toAdminCandidate(existing) }, { "cache-control": "no-store" });
        }
        return jsonResponse(201, { data: toAdminCandidate(record) }, { "cache-control": "no-store" });
      }
      case "POST /v1/candidates/photos": {
        const input = parseJsonBody(event, photoUploadSchema, 3 * 1024 * 1024);
        const photoId = await photos.create(input);
        return jsonResponse(201, { data: { path: `/v1/candidates/photos/${photoId}` } }, { "cache-control": "no-store" });
      }
      case "GET /v1/candidates/photos/{photoId}": {
        const photoId = parseWithSchema(photoIdSchema, event.pathParameters?.photoId);
        const photo = await photos.get(photoId);
        return { statusCode: 200, isBase64Encoded: true, body: Buffer.from(photo.bytes).toString("base64"), headers: { "content-type": photo.contentType, "x-content-type-options": "nosniff", "cache-control": "public,max-age=31536000,immutable" } };
      }
      case "GET /health":
        return jsonResponse(200, { status: "ok", timestamp: new Date().toISOString() }, {
          "cache-control": "no-store",
        });
      case "POST /v1/candidates/submissions":
        return createSubmission(event, requestId);
      case "GET /v1/candidates":
        return listPublic(event);
      case "GET /v1/candidates/{id}":
        return getPublic(event);
      case "GET /v1/admin/candidates":
        return listAdmin(event);
      case "GET /v1/admin/candidates/{submissionId}":
        return getAdmin(event);
      case "PATCH /v1/admin/candidates/{submissionId}":
        return patchAdmin(event);
      case "POST /v1/admin/candidates/{submissionId}/approve":
        return moderateAdmin(event, reviewer as Reviewer, "approved");
      case "POST /v1/admin/candidates/{submissionId}/deny":
        return moderateAdmin(event, reviewer as Reviewer, "denied");
      default:
        throw new ApiError(404, "ROUTE_NOT_FOUND", "Route not found");
    }
  }

  async function handle(
    event: APIGatewayProxyEventV2,
  ): Promise<APIGatewayProxyStructuredResultV2> {
    const requestId = event.requestContext.requestId;
    const startedAt = Date.now();
    let statusCode = 500;

    try {
      const response = await route(event, requestId);
      statusCode = response.statusCode ?? 200;
      return response;
    } catch (error) {
      if (error instanceof ApiError) {
        statusCode = error.statusCode;
        return errorResponse(error, requestId);
      }

      logger.error("request_failed", {
        requestId,
        routeKey: event.routeKey,
        errorName: errorName(error),
      });
      return errorResponse(
        new ApiError(500, "INTERNAL_ERROR", "An unexpected error occurred"),
        requestId,
      );
    } finally {
      logger.info("request_completed", {
        requestId,
        routeKey: event.routeKey,
        statusCode,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  return handle;
}

const repository = new CandidateRepository(process.env.CANDIDATES_TABLE_NAME ?? "");
const emailService = new SubmissionEmailService(
  process.env.SES_FROM_EMAIL ?? "",
  process.env.NOTIFICATION_TO_EMAIL ?? "erik@patriotsinaction.com",
  process.env.REVIEW_PAGE_URL ?? "https://patriotsinaction.com/candidate-review",
);

export const handler = createCandidateHandler(repository, emailService);

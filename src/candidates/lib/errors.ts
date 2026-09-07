import type { ZodError } from "zod";

export interface ValidationDetail {
  path: string;
  message: string;
}

export class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: ValidationDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function validationError(error: ZodError): ApiError {
  return new ApiError(
    400,
    "VALIDATION_ERROR",
    "The request is invalid",
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}

export function notFound(message = "Candidate submission not found"): ApiError {
  return new ApiError(404, "NOT_FOUND", message);
}

export function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

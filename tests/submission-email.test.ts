import { afterEach, describe, expect, it, vi } from "vitest";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { SubmissionEmailService } from "../src/candidates/services/submission-email";
import type { CandidateRecord } from "../src/candidates/domain/types";

const candidate = { id: "alex-example", name: "Alex Example", office: "Governor", stateSlug: "texas", scope: "statewide" as const };
const record: CandidateRecord = {
  submissionId: "change-123", candidate, source: "change-request", status: "pending", revision: 1,
  submitter: { submitterName: "Untrusted recipient", submitterEmail: "submitter@example.com", submitterRole: "other" },
  consent: true, attestation: true, createdAt: "2026-09-09T12:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z", statusUpdatedAt: "2026-09-09T12:00:00.000Z",
  changeRequest: { targetSubmissionId: "alex-example", targetStatus: "pending", targetRevision: 1, baseCandidate: candidate, reason: "Correct the biography" },
  inputFingerprint: "internal-fingerprint",
};
afterEach(() => vi.unstubAllEnvs());

describe("staff notifications", () => {
  it("distinguishes an update request and only sends to configured staff, never the submitter", async () => {
    vi.stubEnv("CANDIDATE_NOTIFICATIONS_ENABLED", "true");
    const send = vi.fn(async (_command: SendEmailCommand, _options?: { abortSignal: AbortSignal }) => ({}));
    const service = new SubmissionEmailService("no-reply@patriotsinaction.com", "staff@patriotsinaction.com", "https://patriotsinaction.com/candidate-review", { send } as unknown as SESv2Client);
    await service.notify(record);
    expect(send).toHaveBeenCalledTimes(1);
    const [command, options] = send.mock.calls[0] as unknown as [SendEmailCommand, { abortSignal: AbortSignal }];
    expect(command.input.Destination).toEqual({ ToAddresses: ["staff@patriotsinaction.com"] });
    expect(command.input.FromEmailAddress).toBe("no-reply@patriotsinaction.com");
    expect(command.input.Content?.Simple?.Subject?.Data).toBe("Candidate profile change request");
    const text = command.input.Content?.Simple?.Body?.Text?.Data;
    expect(text).toContain("change-123");
    expect(text).toContain("Original submission ID: alex-example");
    expect(text).toContain("https://patriotsinaction.com/candidate-review");
    expect(text).not.toContain("internal-fingerprint");
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });
  it("retains the ordinary submission subject", async () => {
    vi.stubEnv("CANDIDATE_NOTIFICATIONS_ENABLED", "true");
    const send = vi.fn(async (_command: SendEmailCommand, _options?: { abortSignal: AbortSignal }) => ({}));
    const service = new SubmissionEmailService("from@example.com", "staff@example.com", "https://example.com/review", { send } as unknown as SESv2Client);
    await service.notify({ ...record, source: "submission", changeRequest: undefined });
    const command = send.mock.calls[0][0] as unknown as SendEmailCommand;
    expect(command.input.Content?.Simple?.Subject?.Data).toBe("New candidate submission");
  });
  it("keeps the deployment mail-disable switch effective for requests", async () => {
    vi.stubEnv("CANDIDATE_NOTIFICATIONS_ENABLED", "false");
    const send = vi.fn(async (_command: SendEmailCommand, _options?: { abortSignal: AbortSignal }) => ({}));
    const service = new SubmissionEmailService("from@example.com", "staff@example.com", "https://example.com/review", { send } as unknown as SESv2Client);
    await service.notify(record);
    expect(send).not.toHaveBeenCalled();
  });
});

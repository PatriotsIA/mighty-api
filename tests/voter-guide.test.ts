import { describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { candidateProfileSchema, candidateSubmissionSchema, voterGuideSchema } from "../src/candidates/domain/schemas";
import { createCandidateHandler } from "../src/candidates/handler";
import { legacyVoterGuideVersion, voterGuide, voterGuideIssues, voterGuideVersion, type VoterGuideResponse } from "../src/voter-guide/model";
import { MemoryRepository } from "./memory-repository";

function response(officeId = "constable"): VoterGuideResponse {
  return { version: voterGuideVersion, officeId, answers: Object.fromEntries(voterGuide.offices.find((office) => office.id === officeId)!.questions.map((question) => [question.number,
    question.type === "primary_history" ? { history: Object.fromEntries(question.years!.map((year) => [year, "Republican"])) }
      : question.type === "checkbox_explain" ? { selections: ["None of the above"], text: "No prior local party activity." }
      : question.type === "yes_no_explain_amounts" ? { choice: "Yes", text: "My explanation.", amounts: Object.fromEntries(question.amountFields!.map((field) => [field, "0"])) }
      : question.type === "yes_no_explain" ? { choice: "No", text: "My explanation." }
      : { text: `Candidate answer ${question.number}.` },
  ])) };
}
const candidate = { id: "questionnaire-test", name: "Questionnaire Candidate", office: "Constable", stateSlug: "texas", scope: "precinct", countySlug: "potter", party: "Republican" };
const submission = (voterGuide?: VoterGuideResponse) => ({ candidate: { ...candidate, ...(voterGuide ? { voterGuide } : {}) }, submitter: { submitterName: "Private Staff", submitterEmail: "private@example.com", submitterRole: "campaign" }, consent: true, attestation: true, honeypot: "" });
function event(routeKey: string, body?: unknown, id = candidate.id, admin = false): APIGatewayProxyEventV2 {
  return { routeKey, body: body === undefined ? undefined : JSON.stringify(body), pathParameters: { id, submissionId: id }, requestContext: { requestId: "questionnaire-test", authorizer: { jwt: { claims: admin ? { sub: "staff", "cognito:groups": ["admins"] } : {} } } } } as unknown as APIGatewayProxyEventV2;
}

describe("voter guide contract", () => {
  it.each(voterGuide.offices)("accepts complete $office responses with the supplied question types", (office) => {
    expect(office.questions.map((question) => question.number)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(candidateSubmissionSchema.safeParse(submission(response(office.id))).success).toBe(true);
  });
  it("preserves legacy profiles and allows partial reviewer drafts and partial new questionnaires", () => {
    expect(candidateSubmissionSchema.safeParse(submission()).success).toBe(true);
    const partial = { ...response(), answers: { "1": { text: "A saved answer." } } };
    expect(candidateProfileSchema.safeParse({ ...candidate, voterGuide: partial }).success).toBe(true);
    expect(candidateSubmissionSchema.safeParse(submission(partial)).success).toBe(true);
    expect(candidateProfileSchema.safeParse({ ...candidate, voterGuide: { ...partial, version: legacyVoterGuideVersion } }).success).toBe(true);
  });
  it("accepts optional private interest flags and rejects non-boolean values", () => {
    const input = submission();
    expect(candidateSubmissionSchema.safeParse({ ...input, submitter: { ...input.submitter, interviewRequested: true, advertisingRequested: false } }).success).toBe(true);
    expect(candidateSubmissionSchema.safeParse({ ...input, submitter: { ...input.submitter, interviewRequested: "yes" } }).success).toBe(false);
    expect(candidateSubmissionSchema.safeParse({ ...input, candidate: { ...input.candidate, advertisingRequested: true } }).success).toBe(false);
  });
  it("enforces 150/50-word limits and a bounded character count", () => {
    const guide = response();
    guide.answers[1].text = Array(150).fill("policy").join("\n");
    guide.answers[19].text = Array(50).fill("explanation").join(" ");
    expect(voterGuideIssues(guide)).toEqual([]);
    guide.answers[1].text += " extra";
    guide.answers[19].text += " extra";
    expect(voterGuideIssues(guide).map((issue) => issue.path)).toEqual([["answers", "1", "text"], ["answers", "19", "text"]]);
    guide.answers[1].text = "a".repeat(4001);
    expect(voterGuideSchema.safeParse(guide).success).toBe(false);
  });
  it.each([
    (guide: any) => { guide.officeId = "unknown-office"; },
    (guide: any) => { guide.version = "unknown-version"; },
    (guide: any) => { guide.answers[21] = { text: "extra" }; },
    (guide: any) => { guide.answers[1].submitterEmail = "private@example.com"; },
    (guide: any) => { guide.answers[11].choice = ["Yes"]; },
    (guide: any) => { guide.answers[16].history[2026] = ["Republican"]; },
    (guide: any) => { guide.answers[16].history[2028] = "Republican"; },
    (guide: any) => { guide.answers[18].selections = ["None of the above", "Precinct chair"]; },
    (guide: any) => { guide.answers[18].selections = ["Precinct chair", "Precinct chair"]; },
    (guide: any) => { guide.answers[19].amounts["Local party, last four years ($)"] = "-1"; },
    (guide: any) => { guide.answers[19].amounts["Local party, last four years ($)"] = "0.001"; },
    (guide: any) => { guide.answers[19].fundSource = ["Both"]; },
  ])("rejects malformed structured answers", (change) => {
    const guide = response(); change(guide);
    expect(voterGuideSchema.safeParse(guide).success).toBe(false);
  });
  it("accepts zero contributions without inventing a source, and accepts optional contribution details", () => {
    const guide = response();
    expect(voterGuideIssues(guide)).toEqual([]);
    guide.answers[19].amounts!["Local party, last four years ($)"] = "50.25";
    expect(voterGuideIssues(guide)).toEqual([]);
    guide.answers[19].fundSource = "Personal funds";
    guide.answers[20] = { choice: "No" };
    expect(voterGuideIssues(guide)).toEqual([]);
  });
});

it("keeps answers private, supports idempotent submission and review, publishes, and applies answer-only change requests", async () => {
  const repository = new MemoryRepository();
  const notify = vi.fn(async () => {});
  const handler = createCandidateHandler(repository, { notify });
  const guide = response();
  const input = submission(guide);
  const interested = { ...input, submitter: { ...input.submitter, interviewRequested: true, advertisingRequested: true } };
  expect((await handler(event("POST /v1/candidates/submissions", interested))).statusCode).toBe(201);
  expect((await handler(event("POST /v1/candidates/submissions", interested))).statusCode).toBe(200);
  const admin = JSON.parse((await handler(event("GET /v1/admin/candidates/{submissionId}", undefined, candidate.id, true))).body!).data;
  expect(admin.submitter.interviewRequested).toBe(true);
  expect(admin.submitter.advertisingRequested).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
  expect((await handler(event("GET /v1/candidates/{id}"))).statusCode).toBe(404);
  expect((await handler(event("GET /v1/candidates"))).body).not.toContain("Candidate answer");
  expect((await handler(event("GET /v1/admin/candidates/{submissionId}"))).statusCode).toBe(403);
  guide.answers[1].text = "Reviewed answer.";
  expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 1, candidate: { voterGuide: guide } }, candidate.id, true))).statusCode).toBe(200);
  expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }, candidate.id, true))).statusCode).toBe(409);
  expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 2 }, candidate.id, true))).statusCode).toBe(200);
  const published = await handler(event("GET /v1/candidates/{id}"));
  expect(JSON.parse(published.body!).data.voterGuide).toEqual(guide);
  expect(published.body).not.toContain("private@example.com");
  expect(published.body).not.toContain("interviewRequested");
  expect(published.body).not.toContain("advertisingRequested");
  const revised = structuredClone(guide); revised.answers[2].text = "A corrected answer.";
  const change = { ...submission(), candidate: { voterGuide: revised }, requestId: "change-questionnaire", targetSubmissionId: candidate.id, targetStatus: "approved", expectedTargetRevision: 3, reason: "Correct answer two." };
  expect((await handler(event("POST /v1/candidates/change-requests", change))).statusCode).toBe(201);
  expect((await repository.get(candidate.id))?.candidate.voterGuide).toEqual(guide);
  expect((await handler(event("POST /v1/admin/candidates/{submissionId}/approve", { expectedRevision: 1 }, change.requestId, true))).statusCode).toBe(200);
  const publicList = JSON.parse((await handler(event("GET /v1/candidates"))).body!).data;
  expect(publicList).toHaveLength(1);
  expect(publicList[0].voterGuide).toEqual(revised);
  expect((await handler(event("PATCH /v1/admin/candidates/{submissionId}", { expectedRevision: 4, candidate: { voterGuide: null } }, candidate.id, true))).statusCode).toBe(200);
  expect(JSON.parse((await handler(event("GET /v1/candidates/{id}"))).body!).data).not.toHaveProperty("voterGuide");
});

it("accepts the full bounded questionnaire payload above the old 64 KiB cap and rejects over 128 KiB", async () => {
  const guide = response();
  for (const answer of Object.values(guide.answers)) if (answer.text !== undefined) answer.text = "x".repeat(4000);
  const payload = submission(guide);
  expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(64 * 1024);
  const handler = createCandidateHandler(new MemoryRepository(), { notify: async () => {} });
  expect((await handler(event("POST /v1/candidates/submissions", payload))).statusCode).toBe(201);
  expect((await handler(event("POST /v1/candidates/submissions", { extra: "x".repeat(128 * 1024) }))).statusCode).toBe(413);
});

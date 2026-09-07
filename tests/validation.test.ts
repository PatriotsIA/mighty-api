import { describe, expect, it } from "vitest";

import { candidateSubmissionSchema } from "../src/candidates/domain/schemas";

function validSubmission() {
  return {
    candidate: {
      name: "Alex Example",
      office: "County Commissioner",
      stateSlug: "texas",
      scope: "county",
      countySlug: "travis",
      countyName: "Travis County",
      websiteUrl: "https://example.com",
      bio: "Candidate biography",
      electionYear: 2026,
    },
    submitter: {
      submitterName: "Alex Example",
      submitterEmail: "Alex@Example.com",
      submitterPhone: "+1 (512) 555-0100",
      submitterRole: "candidate",
    },
    consent: true,
    attestation: true,
    honeypot: "",
  };
}

describe("candidate submission validation", () => {
  it("accepts and normalizes a valid submission", () => {
    const result = candidateSubmissionSchema.parse(validSubmission());

    expect(result.candidate.stateSlug).toBe("texas");
    expect(result.submitter.submitterEmail).toBe("alex@example.com");
  });

  it("rejects a populated honeypot", () => {
    const result = candidateSubmissionSchema.safeParse({
      ...validSubmission(),
      honeypot: "https://spam.example",
    });

    expect(result.success).toBe(false);
  });

  it("rejects oversized and non-http profile values", () => {
    const submission = validSubmission();
    submission.candidate.bio = "x".repeat(5_001);
    submission.candidate.websiteUrl = "javascript:alert(1)";

    const result = candidateSubmissionSchema.safeParse(submission);
    expect(result.success).toBe(false);
  });
});

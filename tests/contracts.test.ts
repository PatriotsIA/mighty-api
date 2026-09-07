import { describe, expect, it } from "vitest";

import { toPublicCandidate } from "../src/candidates/domain/projection";
import {
  adminPatchSchema,
  candidateSubmissionSchema,
} from "../src/candidates/domain/schemas";
import type { CandidateRecord } from "../src/candidates/domain/types";

const validSubmission = {
  candidate: {
    name: "Alex Example",
    office: "County Commissioner",
    stateSlug: "texas",
    scope: "county",
    countySlug: "potter",
    incumbent: false,
  },
  submitter: {
    submitterName: "Campaign Staffer",
    submitterEmail: "staff@example.com",
    submitterRole: "campaign",
  },
  consent: true,
  attestation: true,
  honeypot: "",
} as const;

describe("candidate API contracts", () => {
  it("accepts the nested public submission contract", () => {
    const parsed = candidateSubmissionSchema.parse(validSubmission);
    expect(parsed.candidate.incumbent).toBe(false);
    expect(parsed.submitter.submitterRole).toBe("campaign");
  });

  it("rejects flat submission payloads", () => {
    expect(() =>
      candidateSubmissionSchema.parse({
        name: "Alex Example",
        office: "County Commissioner",
        consent: true,
        attestation: true,
      }),
    ).toThrow();
  });

  it("accepts parish and independent-city selections without merging them with counties", () => {
    for (const selection of [
      { stateSlug: "louisiana", countySlug: "west-carroll", countyName: "West Carroll Parish" },
      { stateSlug: "maryland", countySlug: "baltimore-city", countyName: "Baltimore City" },
      { stateSlug: "maryland", countySlug: "baltimore", countyName: "Baltimore County" },
    ]) {
      expect(candidateSubmissionSchema.safeParse({ ...validSubmission, candidate: { ...validSubmission.candidate, ...selection } }).success).toBe(true);
    }
    expect(candidateSubmissionSchema.safeParse({ ...validSubmission, candidate: { ...validSubmission.candidate, stateSlug: "maryland", countySlug: "baltimore-city", countyName: "Baltimore County" } }).success).toBe(false);
  });

  it("allows administrators to clear incumbent status", () => {
    const parsed = adminPatchSchema.parse({
      expectedRevision: 2,
      candidate: { incumbent: null },
    });
    expect(parsed.candidate?.incumbent).toBeNull();
  });

  it("never exposes moderation or submitter details publicly", () => {
    const now = "2026-08-24T12:00:00.000Z";
    const record: CandidateRecord = {
      submissionId: "alex-example",
      candidate: {
        id: "alex-example",
        name: "Alex Example",
        office: "County Commissioner",
        stateSlug: "texas",
        scope: "county",
        countySlug: "potter",
      },
      submitter: {
        submitterName: "Campaign Staffer",
        submitterEmail: "private@example.com",
        submitterRole: "campaign",
      },
      consent: true,
      attestation: true,
      source: "submission",
      status: "approved",
      createdAt: now,
      updatedAt: now,
      statusUpdatedAt: now,
      revision: 2,
      reviewer: { sub: "private-reviewer-id" },
      reviewReason: "Internal review note",
    };

    expect(toPublicCandidate(record)).toEqual(record.candidate);
    expect(toPublicCandidate(record)).not.toHaveProperty("submitter");
    expect(toPublicCandidate(record)).not.toHaveProperty("reviewer");
  });
});

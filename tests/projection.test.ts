import { describe, expect, it } from "vitest";

import { toPublicCandidate } from "../src/candidates/domain/projection";
import type { CandidateRecord } from "../src/candidates/domain/types";

describe("public candidate projection", () => {
  it("returns profile fields without submission or reviewer PII", () => {
    const record: CandidateRecord = {
      submissionId: "alex-example",
      candidate: {
        id: "alex-example",
        name: "Alex Example",
        office: "County Commissioner",
        stateSlug: "texas",
        scope: "county",
        email: "campaign@example.com",
      },
      submitter: {
        submitterName: "Private Submitter",
        submitterEmail: "private@example.com",
        submitterPhone: "512-555-0100",
        submitterRole: "campaign",
      },
      consent: true,
      attestation: true,
      source: "submission",
      status: "approved",
      createdAt: "2026-08-24T12:00:00.000Z",
      updatedAt: "2026-08-24T13:00:00.000Z",
      statusUpdatedAt: "2026-08-24T13:00:00.000Z",
      revision: 2,
      reviewer: {
        sub: "cognito-user-id",
        email: "reviewer@example.com",
      },
      reviewReason: "Verified",
    };

    const projected = toPublicCandidate(record);

    expect(projected).toEqual(record.candidate);
    expect(projected).not.toHaveProperty("submitter");
    expect(projected).not.toHaveProperty("reviewer");
    expect(projected).not.toHaveProperty("status");
    expect(projected).not.toHaveProperty("revision");
  });
});

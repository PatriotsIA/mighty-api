import { describe, expect, it } from "vitest";

import { moderateCandidateRecord } from "../src/candidates/domain/moderation";
import type { CandidateRecord, Reviewer } from "../src/candidates/domain/types";

const reviewer: Reviewer = {
  sub: "reviewer-sub",
  username: "admin@example.com",
};

function pendingRecord(): CandidateRecord {
  return {
    submissionId: "alex-example",
    candidate: {
      id: "alex-example",
      name: "Alex Example",
      office: "County Commissioner",
      stateSlug: "texas",
      scope: "county",
    },
    submitter: {
      submitterName: "Alex Example",
      submitterEmail: "alex@example.com",
      submitterRole: "candidate",
    },
    consent: true,
    attestation: true,
    source: "submission",
    status: "pending",
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    statusUpdatedAt: "2026-08-24T12:00:00.000Z",
    revision: 1,
  };
}

describe("moderation transitions", () => {
  it("approves a pending record and increments its revision", () => {
    const approved = moderateCandidateRecord(
      pendingRecord(),
      "approved",
      1,
      reviewer,
      "Profile verified",
      "2026-08-24T13:00:00.000Z",
    );

    expect(approved.status).toBe("approved");
    expect(approved.revision).toBe(2);
    expect(approved.reviewer).toEqual(reviewer);
    expect(approved.statusUpdatedAt).toBe("2026-08-24T13:00:00.000Z");
  });

  it("requires a reason when denying a pending record", () => {
    expect(() =>
      moderateCandidateRecord(
        pendingRecord(),
        "denied",
        1,
        reviewer,
        " ",
        "2026-08-24T13:00:00.000Z",
      ),
    ).toThrow("A denial reason is required");
  });

  it("denies a pending record with a reviewer reason", () => {
    const denied = moderateCandidateRecord(
      pendingRecord(),
      "denied",
      1,
      reviewer,
      "Unable to verify the submission",
      "2026-08-24T13:00:00.000Z",
    );

    expect(denied.status).toBe("denied");
    expect(denied.reviewReason).toBe("Unable to verify the submission");
    expect(denied.revision).toBe(2);
  });

  it("rejects terminal-state transitions", () => {
    const approved = moderateCandidateRecord(
      pendingRecord(),
      "approved",
      1,
      reviewer,
      undefined,
      "2026-08-24T13:00:00.000Z",
    );

    expect(() =>
      moderateCandidateRecord(
        approved,
        "denied",
        2,
        reviewer,
        "Changed decision",
        "2026-08-24T14:00:00.000Z",
      ),
    ).toThrow("cannot transition");
  });

  it("rejects stale revisions", () => {
    expect(() =>
      moderateCandidateRecord(
        pendingRecord(),
        "approved",
        7,
        reviewer,
        undefined,
        "2026-08-24T13:00:00.000Z",
      ),
    ).toThrow("changed by another request");
  });
});

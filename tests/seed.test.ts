import { describe, expect, it } from "vitest";

import seedCandidates from "../seed/candidates.json";
import { candidateProfileSchema } from "../src/candidates/domain/schemas";

describe("checked-in candidate seed", () => {
  it("contains 56 valid profiles with unique preserved IDs", () => {
    const candidates = candidateProfileSchema.array().parse(seedCandidates);
    const ids = candidates.map((candidate) => candidate.id);

    expect(candidates).toHaveLength(56);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("aj-casias");
    expect(ids).toContain("zachary-price");
  });
});

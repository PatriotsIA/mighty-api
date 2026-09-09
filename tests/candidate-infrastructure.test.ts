import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const template = readFileSync(new URL("../template.yaml", import.meta.url), "utf8");
function block(name: string, indent: number, source = template): string {
  const start = source.indexOf(`${" ".repeat(indent)}${name}:\n`);
  if (start === -1) return "";
  return source.slice(start).split(new RegExp(`\\n {0,${indent}}\\S`))[0];
}

describe("candidate SAM contracts", () => {
  it("routes public intake and change-target reads to the existing isolated candidate Lambda", () => {
    const candidate = block("CandidateFunction", 2);
    const intake = block("SubmitCandidateChangeRequest", 8, candidate);
    expect(intake).toContain("Type: HttpApi");
    expect(intake).toContain("ApiId: !Ref CandidateHttpApi");
    expect(intake).toContain("Path: /v1/candidates/change-requests");
    expect(intake).toContain("Method: POST");
    expect(intake).toContain("ThrottlingBurstLimit: 5");
    expect(intake).toContain("ThrottlingRateLimit: 2");
    expect(intake).not.toContain("Authorizer:");
    const target = block("GetCandidateChangeTarget", 8, candidate);
    expect(target).toContain("Path: /v1/candidates/{id}/change-target");
    expect(target).toContain("Method: GET");
    expect(target).not.toContain("Authorizer:");
    for (const name of ["CreateResearchDraft", "ListAdminCandidates", "GetAdminCandidate", "PatchAdminCandidate", "ApproveCandidate", "DenyCandidate"]) {
      expect(block(name, 8, candidate)).toContain("Authorizer: CognitoJwtAuthorizer");
    }
  });
  it("keeps conditional transactional Put permissions scoped to candidates without exposing Mighty secrets", () => {
    const candidate = block("CandidateFunction", 2);
    const policies = block("Policies", 6, candidate);
    // DynamoDB authorizes transactional Puts via PutItem, not a separate
    // TransactWriteItems IAM action. No ConditionCheck action is used.
    expect(policies).toContain("dynamodb:PutItem");
    expect(policies).toContain("!GetAtt CandidatesTable.Arn");
    expect(policies).toContain('!Sub "${CandidatesTable.Arn}/index/*"');
    expect(policies).not.toContain("dynamodb:TransactWriteItems");
    expect(policies).not.toContain("Resource: '*'");
    expect(candidate).not.toContain("MightyApiSecretArn");
    expect(candidate).not.toContain("secretsmanager:");
    expect(block("MightyApiFunction", 2)).toContain("secretsmanager:GetSecretValue");
    expect(block("MightyApiFunction", 2)).toContain("FunctionUrlConfig:");
  });
  it("retains the existing table, index and CORS contracts", () => {
    const table = block("CandidatesTable", 2);
    expect(table).toContain("DeletionPolicy: RetainExceptOnCreate");
    expect(table).toContain("UpdateReplacePolicy: Retain");
    expect(table).toContain("IndexName: StatusUpdatedAtIndex");
    expect(table).toContain("AttributeName: submissionId");
    expect(table).toContain("AttributeName: status");
    expect(table).toContain("AttributeName: updatedAt");
    expect(table).toContain("ProjectionType: ALL");
    const api = block("CandidateHttpApi", 2);
    expect(api).toContain("AllowOrigins: !Ref AllowedOrigins");
    expect(api).toContain("AllowMethods: [GET, POST, PATCH, OPTIONS]");
    expect(api).toContain("StageName: !Ref StageName");
  });
});

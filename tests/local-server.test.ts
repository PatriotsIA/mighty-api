import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Server } from "node:http";
import type { AddressInfo } from "node:net";

let server: Server;
let base: string;
beforeAll(async () => {
  // Capture the standalone fixture without binding the browser suite's fixed
  // port. Its real router/storage then run on an isolated ephemeral socket.
  const listen = vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) { server = this; return this; });
  try { await import("./local-server"); } finally { listen.mockRestore(); }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
async function call(method: string, path: string, body?: unknown, admin = false) {
  const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(admin ? { authorization: "Bearer fixture-reviewer-id-token" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const submitter = { submitterName: "Fixture staffer", submitterEmail: "fixture@example.com", submitterRole: "campaign" };
const candidate = { id: "http-published", name: "HTTP Example", office: "Governor", stateSlug: "texas", scope: "statewide", bio: "Original" };

describe("standalone browser fixture HTTP change workflow", () => {
  it("routes published prefill, intake and authenticated acceptance through the real handler", async () => {
    expect((await call("POST", "/v1/candidates/submissions", { candidate, submitter, consent: true, attestation: true })).status).toBe(201);
    expect((await call("POST", "/v1/admin/candidates/http-published/approve", { expectedRevision: 1 }, true)).status).toBe(200);
    const target = await call("GET", "/v1/candidates/http-published/change-target");
    expect(target.status).toBe(200);
    expect(target.headers.get("cache-control")).toBe("no-store");
    expect(target.body.data).toEqual({ candidate, submissionId: "http-published", revision: 2, status: "approved" });
    const input = { requestId: "change-http", targetSubmissionId: "http-published", targetStatus: "approved", expectedTargetRevision: 2, candidate: { bio: "Requested correction" }, reason: "Correct biography", submitter, consent: true, attestation: true, honeypot: "" };
    const receipt = await call("POST", "/v1/candidates/change-requests", input);
    expect(receipt.status).toBe(201);
    expect(Object.keys(receipt.body.data).sort()).toEqual(["createdAt", "revision", "status", "submissionId"]);
    expect((await call("GET", "/v1/admin/candidates/change-http")).status).toBe(403);
    expect((await call("GET", "/v1/candidates/change-http")).status).toBe(404);
    expect((await call("PATCH", "/v1/admin/candidates/change-http", { expectedRevision: 1, candidate: { bio: "Reviewed correction" }, reviewReason: "Sources verified" }, true)).status).toBe(200);
    expect((await call("POST", "/v1/admin/candidates/change-http/approve", { expectedRevision: 2 }, true)).status).toBe(200);
    expect((await call("GET", "/v1/candidates/http-published")).body.data.bio).toBe("Reviewed correction");
    expect((await call("GET", "/v1/candidates/change-http/change-target")).status).toBe(404);
    const all = (await call("GET", "/v1/candidates")).body.data;
    expect(all).toEqual([{ ...candidate, bio: "Reviewed correction" }]);
    expect((await call("POST", "/v1/candidates/change-requests", input)).body).toEqual(receipt.body);
  });
  it("keeps pending narrative references and accepted corrections private over HTTP", async () => {
    const draft = { ...candidate, id: "http-pending" };
    expect((await call("POST", "/v1/admin/candidates", { candidate: draft, reviewReason: "Research source" }, true)).status).toBe(201);
    expect((await call("GET", "/v1/candidates/http-pending/change-target")).status).toBe(404);
    expect((await call("POST", "/v1/candidates/change-requests", { requestId: "change-http-pending", targetSubmissionId: "http-pending", targetStatus: "pending", reason: "Correct biography", submitter, consent: true, attestation: true, honeypot: "" })).status).toBe(201);
    const privateRequest = await call("GET", "/v1/admin/candidates/change-http-pending", undefined, true);
    expect(privateRequest.body.data.changeRequest.baseCandidate).toEqual(draft);
    expect((await call("POST", "/v1/admin/candidates/change-http-pending/approve", { expectedRevision: 1 }, true)).status).toBe(409);
    expect((await call("PATCH", "/v1/admin/candidates/change-http-pending", { expectedRevision: 1, candidate: { bio: "Private correction" } }, true)).status).toBe(200);
    expect((await call("POST", "/v1/admin/candidates/change-http-pending/approve", { expectedRevision: 2 }, true)).status).toBe(200);
    expect((await call("GET", "/v1/candidates/http-pending")).status).toBe(404);
    expect((await call("GET", "/v1/admin/candidates/http-pending", undefined, true)).body.data).toMatchObject({ status: "pending", source: "research", consent: false, attestation: false, candidate: { bio: "Private correction" } });
  });
});

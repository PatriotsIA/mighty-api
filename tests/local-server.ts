import { createServer } from "node:http";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createCandidateHandler } from "../src/candidates/handler";
import { MemoryRepository } from "./memory-repository";

import { decodePhoto } from "../src/candidates/services/photos";
import { notFound } from "../src/candidates/lib/errors";
const photos = new Map<string, { bytes: Uint8Array; contentType: string }>();
const handle = createCandidateHandler(new MemoryRepository(), { notify: async () => {} }, {
  create: async (input) => { const bytes = decodePhoto(input); const id = `${crypto.randomUUID()}.${input.contentType === "image/jpeg" ? "jpg" : input.contentType.split("/")[1]}`; photos.set(id, { bytes, contentType: input.contentType }); return id; },
  get: async (id) => { const photo = photos.get(id); if (!photo) throw notFound(); return photo; },
});
const routes = ["POST /v1/admin/candidates", "POST /v1/candidates/photos", "GET /v1/candidates/photos/{photoId}", "GET /health", "POST /v1/candidates/submissions", "GET /v1/candidates", "GET /v1/candidates/{id}", "GET /v1/admin/candidates", "GET /v1/admin/candidates/{submissionId}", "PATCH /v1/admin/candidates/{submissionId}", "POST /v1/admin/candidates/{submissionId}/approve", "POST /v1/admin/candidates/{submissionId}/deny"];
const server = createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  const url = new URL(request.url || "/", "http://localhost");
  const routeKey = routes.find((route) => new RegExp("^" + route.replace(/\{[^}]+\}/g, "[^/]+") + "$").test(`${request.method} ${url.pathname}`)) || "$default";
  const parameter = /\{([^}]+)\}/.exec(routeKey)?.[1];
  const parts = url.pathname.split("/");
  const body: Buffer[] = [];
  for await (const chunk of request) body.push(Buffer.from(chunk));
  const result = await handle({
    routeKey, body: Buffer.concat(body).toString(), isBase64Encoded: false,
    pathParameters: parameter ? { [parameter]: parts[parameter === "id" ? 3 : 4]! } : {},
    queryStringParameters: Object.fromEntries(url.searchParams),
    requestContext: { requestId: crypto.randomUUID(), authorizer: { jwt: { claims: request.headers.authorization === "Bearer fixture-reviewer-id-token" ? { sub: "fixture-reviewer", "cognito:groups": ["admins"] } : {} } } },
  } as unknown as APIGatewayProxyEventV2);
  response.writeHead(result.statusCode || 200, result.headers as Record<string, string>).end(result.isBase64Encoded ? Buffer.from(result.body || "", "base64") : result.body);
});
server.listen(8791, "127.0.0.1", () => console.log("Test-only candidate API listening at http://127.0.0.1:8791; no AWS or email calls."));

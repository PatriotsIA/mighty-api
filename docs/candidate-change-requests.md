# Candidate profile change requests

Change requests are **private review records**, not new candidate profiles. They use the existing candidate API/Lambda, DynamoDB table, status index, Cognito admin group, and fixed staff SES notification configuration. API base URLs must retain their stage (normally `/prod`).

## Public API

### `GET /v1/candidates/{id}/change-target`

Returns `200` only for an **approved original** (not a change request):

```json
{
  "data": {
    "candidate": {
      "id": "alex-example",
      "name": "Alex Example",
      "office": "Governor",
      "stateSlug": "texas",
      "scope": "statewide"
    },
    "submissionId": "alex-example",
    "revision": 3,
    "status": "approved"
  }
}
```

`candidate` contains only profile fields. Submitter details, consent, attestation, reviewer identities, notes, provenance, and internal fingerprints are not returned. Success and errors use `Cache-Control: no-store`. Missing, pending, denied, and change-request IDs return `404`; malformed IDs return `400`. References are literal lowercase slugs, not silently trimmed or lowercased.

There is **no public pending-profile lookup or prefill**. A person requesting an update to a pending submission supplies their original receipt's `submissionId` and narrative instructions. Reviewers get its snapshot privately.

### `POST /v1/candidates/change-requests`

A public request body is one of two strict shapes. Unknown properties are rejected.

| Property | Contract |
| --- | --- |
| `requestId` | Required lowercase slug, 1–100 characters: `^[a-z0-9]+(?:-[a-z0-9]+)*$`. Generate once with `` `change-${crypto.randomUUID()}` `` and reuse **only for identical retries**. |
| `targetSubmissionId` | Required literal lowercase slug, 1–100 characters; references an existing original. |
| `targetStatus` | Required `pending` or `approved`; must match the stored original's current status. |
| `expectedTargetRevision` | Positive integer, **required for approved**. Optional for pending; if provided it must match. The server always snapshots the stored revision. |
| `candidate` | **Required for approved**, using the existing nonempty [candidate patch schema](../src/candidates/domain/schemas.ts). Partial profile fields only; never `id`. Nullable optional fields can be removed with `null`. **Forbidden for pending**, including an empty patch: rejection happens before any target lookup or merged-field validation. |
| `reason` | Required trimmed nonempty string, maximum 2,000 characters. Instructions from the requester; immutable, separate from reviewer notes. |
| `submitter` | Required existing private submitter object: `submitterName`, `submitterEmail`, `submitterRole`, optional `submitterPhone`. Roles: `candidate`, `campaign`, `volunteer`, `party`, `other`. |
| `consent`, `attestation` | Both required and exactly `true`; they belong to the **request**, not the original. |
| `honeypot` | Required and exactly `""`. |

Approved profile example (the revision comes from `change-target`):

```json
{
  "requestId": "change-7f43b9ba-a848-40f4-a5da-8e32223fdd65",
  "targetSubmissionId": "alex-example",
  "targetStatus": "approved",
  "expectedTargetRevision": 3,
  "candidate": { "bio": "Corrected biography", "websiteUrl": null },
  "reason": "Please correct the biography and remove the old website.",
  "submitter": {
    "submitterName": "Campaign Staffer",
    "submitterEmail": "staff@example.com",
    "submitterRole": "campaign"
  },
  "consent": true,
  "attestation": true,
  "honeypot": ""
}
```

Pending narrative example:

```json
{
  "requestId": "change-f73a83f2-8ae7-491e-bd9a-42412a923cfb",
  "targetSubmissionId": "alex-example",
  "targetStatus": "pending",
  "reason": "Please replace the old campaign website with https://example.com/new.",
  "submitter": {
    "submitterName": "Campaign Staffer",
    "submitterEmail": "staff@example.com",
    "submitterRole": "campaign"
  },
  "consent": true,
  "attestation": true,
  "honeypot": ""
}
```

The server verifies that the target exists, is not itself a request or denied, and matches the supplied status/revision before snapshotting it. Intake **never modifies the original**. An approved proposal is formed by applying the patch to that snapshot and validating the resulting profile. A pending proposal starts as an unchanged copy of the snapshot; only staff can enter the requested edits.

New persistence returns `201` with only this receipt, never the target or its private state:

```json
{
  "data": {
    "submissionId": "change-7f43b9ba-a848-40f4-a5da-8e32223fdd65",
    "status": "pending",
    "createdAt": "2026-09-09T12:00:00.000Z",
    "revision": 1
  }
}
```

An identical retry returns `200` with **that original intake receipt**, even after staff edit/approve/deny the request or the target changes/disappears. This is intentionally not a public moderation-status lookup. A canonical fingerprint of validated input ignores object-key ordering, but retains supplied fields and array order. Changed input under the same ID returns `409 CANDIDATE_ID_EXISTS`. Conditional creation handles simultaneous retries without overwriting originals, research drafts, submissions, or other requests. Only the winning create attempts notification; retries never duplicate email. All responses are `no-store`.

Notifications use the existing fixed configured staff recipient, never a submitter-supplied address. The subject is `Candidate profile change request`, and the body identifies the request and original. The existing notification-disable switch and bounded SES timeout remain in effect. Email failure does not invalidate a durable receipt.

## Private review API

All existing `/v1/admin/candidates` routes require a Cognito JWT and the `admins` group. Their responses are `no-store` and use an explicit allowlist of private API fields, **not a raw DynamoDB record**.

- `GET /v1/admin/candidates?status=pending` includes requests in the normal queue.
- `GET /v1/admin/candidates/{submissionId}` returns the current proposal, requester's private submitter data, review state, and immutable `changeRequest` baseline/instructions.
- `GET /v1/admin/candidates?status=approved` also includes accepted request audit records. The frontend's **published original profiles** view must filter `source !== 'change-request'`; it must not equate every approved record with a published profile. No new server-side source query parameter is introduced.
- `PATCH /v1/admin/candidates/{requestId}` edits the **proposed candidate**, never the original. It requires `expectedRevision` and accepts `candidate`, `submitter`, and/or `reviewReason`. Saving notes alone is valid. `reviewReason` is trimmed, at most 2,000 characters; `null` or an empty string clears it, omission preserves it. Every successful save increments the request revision. IDs, source, status, baseline, consent, attestation, and fingerprints cannot be patched.
- `PATCH /v1/admin/candidates/{originalId}` continues to allow revision-checked direct edits to published originals. It does not require or create an update request. Editing an original makes older requests stale.
- `POST /v1/admin/candidates/{requestId}/approve` takes `{ "expectedRevision": 2, "reason": "Optional reviewer decision note" }`. Use the revision returned by the last save. It conditionally approves the request and applies its proposed candidate to the original **atomically**. The original's status stays pending or approved as before. Accepting a pending target's update **does not publish it**; publishing still requires separate review/approval of the original.
- `POST /v1/admin/candidates/{requestId}/deny` takes `{ "expectedRevision": 2, "reason": "Required denial note" }`. It changes only the request and remains available for stale/deleted-target requests.

Approval preserves the original's `submissionId`, candidate ID, source, submitter, consent, attestation, creation timestamp, publication/status timestamp, and original moderation reviewer/notes. It updates only the candidate, `updatedAt`, revision, and private `lastChangeRequest` audit pointer. This audit contains `{submissionId, appliedAt, reviewer, previousRevision}` and identifies the staff member who accepted the correction, rather than falsely attributing it to the original publisher. The accepted request retains its own reviewer, notes, immutable baseline and intake fingerprint. Historical accepted requests remain private audit records.

Approved and denied requests are **read-only**. PATCH returns `409 CHANGE_REQUEST_CLOSED`; repeated or reversed decisions return `409` (`REVISION_CONFLICT` or `INVALID_STATUS_TRANSITION`). No second application is possible. After a lost moderation response, privately GET the request to inspect the actual decision; do not blindly retry against a newer revision.

### Conflict handling

| Error | Meaning and next action |
| --- | --- |
| `400 VALIDATION_ERROR` | Malformed body/reference, forbidden pending patch, ID override, invalid merged public profile, missing consent, etc. No record is written. |
| `404 NOT_FOUND` | Unknown/denied/request target at intake, or non-public original at public GET. No draft fields are returned. |
| `409 CANDIDATE_ID_EXISTS` | ID is occupied by different input or another record type. Preserve the original receipt; generate a new request ID only for a genuinely new submission. |
| `409 REVISION_CONFLICT` | Another reviewer edited or decided this request. Privately reload before proceeding. |
| `409 NO_EFFECTIVE_CHANGE` | The proposed profile still equals the immutable baseline. **Edit candidate fields** before accepting, or deny. Review notes/submitter changes alone are not a profile correction. County coverage is compared as an unordered, deduplicated set; omitted and empty coverage are equivalent, so representation-only changes cannot permit acceptance. This guards narrative-only pending requests in particular. |
| `409 CHANGE_TARGET_CONFLICT` | Target revision/status/identity changed, target disappeared or became a request, or an atomic transaction conflicted/was cancelled without detailed reasons. Nothing in this attempted application was written. |

For stale targets the API instructs: **Open the original, compare the changes and resolve manually, or deny this request and resubmit.** Saving request edits does not refresh its baseline. Never silently rebase or replace the original with a stale snapshot. A reviewer can use the existing original PATCH route to apply a manually reconciled correction using the original's current revision, then deny the obsolete request with an explanatory note.

## Storage and transactional guarantees

The existing `CandidatesTable` hash key (`submissionId`), `StatusUpdatedAtIndex` (`status`, `updatedAt`), retention policies, encryption, and recovery settings remain unchanged. Request records add:

```text
submissionId = requestId
source = 'change-request'
status = 'pending' | 'approved' | 'denied'
candidate.id = original candidate ID (not requestId)
candidate = current proposed profile
changeRequest = {
  targetSubmissionId,
  targetStatus: 'pending' | 'approved',
  targetRevision,
  baseCandidate,             // immutable original profile snapshot
  reason                    // immutable requester's instructions
}
inputFingerprint            // immutable SHA-256 of canonical validated input
```

`inputFingerprint` and unknown future internal storage fields are never included in admin or public projections. `changeRequest` and `lastChangeRequest` have explicit private projections. There are no public draft-prefill routes. All public list queries filter out `source='change-request'`, including accepted requests against still-pending originals; both public GET routes reject request records. Existing state/county/statewide placement filters are preserved.

### Public list pagination

`GET /v1/candidates` keeps the `{ data, nextCursor? }` response shape and existing `stateSlug`, `countySlug`, `limit` (1–100, default 100), and `cursor` inputs. `limit` bounds **returned matching originals**, not a single DynamoDB evaluated page. Results retain the index's descending `updatedAt` order; equal timestamps use DynamoDB's index order, not an application-side sort.

- The server drains filtered/empty DynamoDB pages internally, filling up to `limit` originals and looking ahead for another eligible original. An empty public `data` page has **no** `nextCursor`. A short page is exhausted; even a full page omits `nextCursor` when only filtered/private records remain.
- An outgoing public cursor encodes only `{ submissionId, status: 'approved', updatedAt }` from the **last returned original**. It never encodes a filtered request's `LastEvaluatedKey`, ID, decision state or timestamp. These are full table/GSI continuation keys, not `candidate.id` or `statusUpdatedAt`. The existing base64url format is unchanged; encoding is not encryption.
- Internal evaluated boundaries stay server-side. Continuation resumes after the last returned original, re-reading any filtered suffix/lookahead rather than losing the looked-ahead original. Clients must keep the same placement filters and follow `nextCursor` until absent; cursors are not filter-bound or authenticated. Admin pagination retains its existing private evaluated-boundary cursors.

This requires no cursor secrets, keys, new indexes, migration or IAM permissions. It can require multiple DynamoDB queries and, for sparse/no matches, traversal of the remaining approved partition; there is no partial-success fallback that exposes a private boundary or falsely reports exhaustion. Read failures/timeouts remain errors. Pagination is not a snapshot: like the existing eventually consistent GSI, concurrent edits/publication can move records across boundaries. The no-loss/no-duplication guarantee is for a stable index and unchanged filters; request timing/read cost is not constant.

### Atomic acceptance

Acceptance uses **one DynamoDB `TransactWriteCommand` with two conditional Puts**. The request condition checks existence, its expected revision, pending status, request source and baseline candidate ID. The original condition checks existence, baseline revision/status, non-request source and baseline candidate ID. Concurrent changes after the initial consistent reads still fail at the write boundary. There is no sequential-write fallback. Transaction cancellation/conflict errors become `409`; explicit capacity/validation infrastructure failures remain server errors, not success. The test memory repository checks both live records before either write and performs both writes without an intervening `await`.

No IAM expansion is needed: DynamoDB authorizes transactional `Put` actions using the existing `dynamodb:PutItem` permission on the candidate table. These Puts include conditions; they do not use a separate `ConditionCheck` transaction action. See [AWS: using IAM with DynamoDB transactions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html). Do not invent a `dynamodb:TransactWriteItems` IAM action or broaden the candidate role to Mighty secrets.

## Verification and release

Use strict vertical RED → GREEN slices: real-handler intake/privacy, immutable retries, review notes, published/pending acceptance, no-op/closed/stale guards, reviewer races, DynamoDB command/filter contracts, notification and SAM contracts. The standalone HTTP fixture tests use the real local server on isolated ephemeral ports; the PIA Playwright suite continues using `tests/local-server.ts` and `MemoryRepository`, without DynamoDB/Cognito/SES calls.

```bash
mise exec node@22 -- npm run typecheck
mise exec node@22 -- npm test
mise exec node@22 -- npm run build
sam validate --lint --profile pia --region us-east-2
```

**Release backend first**, then the frontend that uses Request Changes and published-profile admin navigation. Verify the new public routes, admin authorization, original-only public lists/GETs, and stale-conflict UX before enabling the frontend entry points. SAM adds only the two public routes; change-request POST has the same low throttle as ordinary intake. Existing Lambda separation, Mighty Function URL, CORS, Cognito roles, table/GSI, retained resources and SES identity remain intact.

No migration or reseeding is required. Do **not** roll the backend back to code that treats every approved table record as a public profile after any change request has been accepted: old public list/get code would expose accepted request records. Keep request filtering/projection and moderation protections in any rollback. Follow the existing production release workflow in [candidates.md](candidates.md); development checks do not authorize deployment, AWS writes, or real test email.

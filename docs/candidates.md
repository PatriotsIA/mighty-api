# PIA candidate deployment

Production candidates belong to this project and the existing `mighty-api-production` stack in **us-east-2**. Use the **pia** AWS CLI profile and verify account **426771918029**. The earlier `pia-candidate-api` checkout supplied the initial implementation; it is not a second production deployment.

The stack preserves `MightyApiFunction`, its Function URL, secrets and CORS. Candidate requests use the separate `CandidateApiUrl` output, including `/prod`. API Gateway validates Cognito JWTs before protected routes run; the candidate handler additionally requires the `admins` group. Its execution role grants only candidate table access and SES sending from `patriotsinaction.com`. It cannot retrieve the Mighty secret. News stays in `county-post-news-api`.

## Build and release

Run Node 22, `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and `sam validate --lint --profile pia --region us-east-2`. The standard SAM build packages `dist/handler.handler` and `dist/candidates/handler.handler`. CodeBuild runs the same checks through its service role; do not set the workstation `pia` profile in CodeBuild.

The existing CloudFormation execution role also needs [candidate resource permissions](candidate-deploy-policy.json), including **apigateway:TagResource** and **apigateway:UntagResource** for API Gateway v2 stages. Existing stack parameters for the Mighty secret, network and CORS must be retained during updates.

```bash
sam build --profile pia --region us-east-2
sam deploy --profile pia --region us-east-2 \
  --stack-name mighty-api-production \
  --s3-bucket codepipelinestartertempla-codepipelineartifactsbuc-y93cghqyfqye \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND
```

Set these frontend public variables from stack outputs before the Amplify release:

| Frontend setting | Stack output |
| --- | --- |
| VITE_CANDIDATE_API_BASE | CandidateApiUrl |
| VITE_CANDIDATE_COGNITO_CLIENT_ID | CandidateUserPoolClientId |
| VITE_CANDIDATE_COGNITO_REGION | us-east-2 |

`VITE_MIGHTY_API_BASE` retains `MightyApiUrl`; `VITE_NEWS_API_URL` retains the County Post news service URL. PIA Amplify app `d1c230b674qax4` is in **us-west-1**.

## Data and reviewers

```bash
AWS_PROFILE=pia AWS_REGION=us-east-2 npm run seed:candidates -- --dry-run
AWS_PROFILE=pia AWS_REGION=us-east-2 npm run seed:candidates -- --table <CandidatesTableName>
```

Seed the 56 existing public profiles before the frontend switches to the API. Conditional writes preserve existing edits on subsequent seed runs. Submitter and moderation data remain private. Intake uses `/candidate-form`; reviewers use `/candidate-review`. Test-only `tests/local-server.ts` runs the real router against fixture storage, with no AWS/email calls; the PIA browser suite uses this checkout by default.

Create reviewers in `CandidateUserPoolId`, add the `admins` group, and set a permanent password before first login. Keep passwords and JWTs out of repositories, command output and test traces. The deployment bootstrap suppresses invitation emails and saves the generated reviewer credential in a local file with owner-only permissions. The UI supports login and existing software-token MFA challenges; MFA enrollment remains an administrator setup step.

To add staff reviewers, run `python3 scripts/create-reviewers.py <staff-email> ...`. It uses `aws --profile pia`, verifies the expected account and production pool, suppresses invitation mail, assigns the `admins` group and sets generated permanent passwords. It verifies sign-in and access to the protected review endpoint, then signs out the test session. Owner-only credentials are retained at `~/.local/share/pia/candidate-reviewers.json`; retries retain those credentials and do not reset existing confirmed users. Do not commit this file or include it in test traces.

Candidate tables and SES identity use `RetainExceptOnCreate`: failed initial provisioning can clean itself up, while later deletion retains established data/identity. Table replacements also retain data. Restore or delete production records only under an explicit operational request.

## Notifications

CloudFormation creates a `patriotsinaction.com` SES domain identity and three Easy DKIM CNAME records in the existing Route 53 zone. Verify `sesv2 get-email-identity` reports success before enabling notifications. This adds DKIM records without changing MX, SPF, nameservers or existing mail delivery. Domain verification permits the configured sender and the staff recipient on that domain, including while SES remains in its sandbox. See [SES identity requirements](https://docs.aws.amazon.com/ses/latest/APIReference/API_SendEmail.html).

`CandidateNotificationsEnabled=false` suppresses messages during initial persistence/authentication smoke tests. Set it to `true` after the test record is removed and DNS verification succeeds. Notification failures do not erase a stored submission; SES attempts are bounded to three seconds. Staff reads new records in the review console even if email is temporarily unavailable.

## Profile photos, placement, and research drafts

`POST /v1/candidates/photos` accepts `{contentType, dataBase64}` for JPEG, PNG, or WebP, capped at 2 MiB decoded. The browser accepts originals up to 5 MiB, resizes to a maximum 1600-pixel edge and re-encodes JPEG before uploading. The API checks canonical base64, byte size, and image signatures before writing a UUID-named object into a retained, encrypted S3 bucket with all public access blocked. The candidate function has GetObject/PutObject access only to `photos/*`; no public bucket policy or ACL is used. `GET /v1/candidates/photos/{photoId}` serves the image through API Gateway with a fixed image MIME type, nosniff, and immutable caching. Preserve the API's `/prod` stage in stored photo URLs. Uploads have a separate low route throttle.

Optional `officeLevel` (`local`, `state`, `federal`) describes the office independently of geographic `scope`. `countySlug` identifies the primary county; `countySlugs` lists additional covered counties. Every county must belong to the selected canonical state. Statewide profiles match all counties in that state; district/city profiles match only their listed coverage. A public county filter requires `stateSlug` as well. These additions remain compatible with existing profiles and consumers.

Authenticated admins can create a pending research draft with `POST /v1/admin/candidates` and `{candidate, reviewReason}`. Include a stable candidate ID, verified facts, and source URLs in the review notes. This records `source=research`, `consent=false`, `attestation=false`, and never sends a submission email. It does not invent campaign authorization or publish the profile. Identical retries are idempotent; existing data is never overwritten. Publication uses the usual revision-checked approval route after review.

Admin password changes call Cognito `ChangePassword` with the active access token and the current and new password. The review UI keeps its in-memory session and unsaved editor values after a successful change. Verify with a temporary, invitation-suppressed test reviewer, then remove only that test account; never change a real staff password as a test.

# Mighty API AWS CodePipeline Deployment Guide

This guide deploys Mighty API from GitHub through AWS CodeConnections, CodePipeline, CodeBuild, and CloudFormation/SAM. It deliberately follows the same deployment shape as `county-post-news-api`:

```text
GitHub (main) -> CodePipeline Source -> CodeBuild -> CloudFormation/SAM -> Lambda Function URL
                                                                          ^
patriotsinaction.com -----------------------------------------------------+
```

The public API has read-only routes, while the Mighty Networks Admin token stays in AWS. Never place the token in the frontend, a Vite `VITE_*` variable, GitHub repository secrets, or a checked-in `.env` file.

## Deployment Support Included

This repository now includes a Lambda handler, SAM template, and CodeBuild buildspec. The Express application exports an app for Lambda and starts its local HTTP listener only when run through `npm start` or `npm run dev`.

The Lambda reads `MIGHTY_API_KEY` from Secrets Manager at runtime. It caches the value and the Mighty client for warm Lambda invocations. Local development still uses `MIGHTY_API_KEY` from `.env`.

## Architecture and Production Decisions

- AWS region: choose one region and use it for CodePipeline, CodeBuild, CodeConnections, the artifact bucket, CloudFormation, Lambda, and Secrets Manager. `us-east-1` is a reasonable default if no other application requirement dictates a region.
- Runtime: Node.js 20 on ARM64 Lambda.
- Endpoint: a public Lambda Function URL with no AWS authentication. Browser CORS restricts browser callers but is not access control; the routes themselves must remain read-only.
- Secret: store `MIGHTY_API_KEY` in AWS Secrets Manager. Lambda reads it at runtime with a narrowly scoped IAM permission.
- CORS origins: use the exact origins `https://patriotsinaction.com` and `https://www.patriotsinaction.com` only if both serve the frontend. Add the actual Amplify/custom-preview origin only if it must call production. Do not include trailing slashes.
- Public URL: begin with the Lambda Function URL, then optionally put an API subdomain such as `https://api.patriotsinaction.com` in front of it using CloudFront and Route 53.

## 1. Preflight and Secrets

1. Make sure the project is in a private GitHub repository and that `.env` remains ignored. Check this before the first push:

   ```bash
   git status --ignored
   git ls-files .env
   ```

   The second command must print nothing.

2. Treat any Mighty Admin token that has ever been committed, pasted into chat, shared, or used outside a trusted secret store as compromised. Revoke it in Mighty Networks and create a replacement before production deployment.

3. In the selected AWS region, open **Secrets Manager** and choose **Store a new secret**:
   - Secret type: **Other type of secret**
   - Key/value: `MIGHTY_API_KEY` / the replacement token
   - Secret name: `mighty-api/production`
   - Turn on rotation only if there is an established process to update the Mighty Networks token.

4. Record the secret ARN. It will be supplied to the stack as the `MightyApiSecretArn` parameter. Do not put the token itself in CloudFormation parameters, CodeBuild variables, or pipeline logs.

## 2. Review the Included Repository Deployment Files

Review and locally validate the included deployment support before building AWS resources.

### 2.1 Adapt Express for Lambda

`src/index.ts` exports the configured Express app and only calls `app.listen()` for local execution. `src/handler.ts` adapts that app with `serverless-http`.

Required packages and scripts are already present:

```bash
npm run typecheck
npm run build
```

Keep the compiled handler path and the SAM `Handler` property in sync. With the current TypeScript settings (`rootDir: src`, `outDir: dist`), `src/handler.ts` compiling to `dist/handler.js` means the Lambda handler is:

```text
dist/handler.handler
```

Do not run `app.listen()` inside Lambda. Lambda invokes the handler for each request.

### 2.2 Load the Mighty secret at runtime

The production deployment uses a runtime Secrets Manager lookup:

1. Add `MIGHTY_API_SECRET_ARN` to the Lambda environment.
2. On cold start, call `secretsmanager:GetSecretValue` for that ARN.
3. Parse the JSON secret and use its `MIGHTY_API_KEY` property to construct the Mighty client.
4. Cache the parsed secret in the module scope for warm invocations.
5. Keep `.env` support only for local development.

The Lambda execution role, not CodeBuild or the browser, must receive `secretsmanager:GetSecretValue`. Scope that permission to the one production secret ARN.

### 2.3 Add `template.yaml`

The included SAM template:

- uses `Transform: AWS::Serverless-2016-10-31`;
- defines a `MightyApiFunction` with `CodeUri: .`, `Handler: dist/handler.handler`, `Runtime: nodejs20.x`, `Architectures: [arm64]`, 30-second timeout, and 512 MB memory;
- creates a public Function URL (`AuthType: NONE`);
- accepts a `MightyApiSecretArn` parameter and provides it as `MIGHTY_API_SECRET_ARN`;
- sets `CORS_ORIGIN` to the production allowlist;
- grants the function `secretsmanager:GetSecretValue` only for `MightyApiSecretArn`;
- outputs the Function URL as `MightyApiUrl`.

Do not configure Function URL CORS as well as Express CORS. This API already handles CORS in Express; configuring both can result in duplicate `Access-Control-Allow-Origin` headers, which browsers reject.

The current Express configuration supports `CORS_ORIGIN` as a comma-separated allowlist. Set it to:

```text
https://patriotsinaction.com,https://www.patriotsinaction.com
```

Use `*` only for local development, never the production Lambda.

### 2.4 Add `buildspec.yml`

The repository-root `buildspec.yml` runs:

```yaml
version: 0.2

phases:
  install:
    runtime-versions:
      nodejs: 20
    commands:
      - npm ci
      - python3 -m pip install --user aws-sam-cli
      - $HOME/.local/bin/sam --version
  pre_build:
    commands:
      - npm run typecheck
      - $HOME/.local/bin/sam validate
  build:
    commands:
      - npm run build
      - $HOME/.local/bin/sam build
      - $HOME/.local/bin/sam package --template-file .aws-sam/build/template.yaml --s3-bucket "$ARTIFACT_BUCKET" --output-template-file packaged.yaml

artifacts:
  files:
    - packaged.yaml
```

The buildspec installs the SAM CLI at build time and runs a no-emit TypeScript typecheck. Add `npm test` when a test suite is available. `sam package` converts the local `CodeUri: .` into an S3 object reference. The deploy stage must use `packaged.yaml`, not raw `template.yaml`.

### 2.5 Verify locally

Before pushing:

```bash
npm ci
npm run typecheck
npm run build
sam validate
sam build
```

Start locally with a safe development `.env` and verify:

```bash
curl http://localhost:4001/health
curl "http://localhost:4001/spaces?per_page=1"
```

Commit and push the handler, SAM template, buildspec, lockfile, and documentation to the deployment branch, normally `main`. Do not commit `.env`, `.aws-sam`, `dist`, or secret values.

### 2.6 Final checklist before creating the pipeline

Complete these items before opening the CodePipeline wizard:

- Confirm the GitHub repository is private and that `git ls-files .env` prints nothing.
- Commit and push the current deployment files to `main`; CodePipeline builds the GitHub source revision, not local files.
- Rotate the Mighty Admin token if it has ever been committed, pasted, shared, or otherwise exposed. Store only the replacement in Secrets Manager.
- Create the `mighty-api/production` secret with JSON key `MIGHTY_API_KEY`, then retain its ARN for the `MightyApiSecretArn` stack parameter.
- Record the Mighty network ID for the required `MightyNetworkId` stack parameter.
- Choose one AWS region for Secrets Manager, S3, CodeConnections, CodeBuild, CodePipeline, CloudFormation, and Lambda.
- Confirm the exact frontend origins that will call the API. The template defaults to `https://patriotsinaction.com,https://www.patriotsinaction.com`; change the `CorsOrigin` parameter only if the deployed frontend uses other origins.
- Ensure the CodeBuild project has outbound internet access. It downloads npm packages, installs the SAM CLI, and packages the Lambda. A CodeBuild project attached to a private VPC requires a NAT gateway or equivalent egress.

Installing the SAM CLI locally and running `sam validate` is recommended, but not a prerequisite: the included CodeBuild buildspec installs SAM and runs validation during every pipeline build.

## 3. Create the AWS Prerequisites

### 3.1 Artifact bucket

Create a private, versioned S3 bucket in the selected region, for example:

```text
mighty-api-artifacts-<account-id>-<region>
```

Enable:

- **Block all public access**
- **Bucket Versioning**
- default encryption (SSE-S3 is sufficient unless organizational policy requires a customer-managed KMS key)

The CodeBuild service role needs `s3:PutObject`, `s3:GetObject`, and `s3:ListBucket` on this bucket. This bucket is for SAM deployment packages, not for public API files.

### 3.2 GitHub connection

1. Open **Developer Tools > Settings > Connections** in the same region.
2. Create a **GitHub** CodeConnections connection.
3. Authorize the GitHub organization/account and select the Mighty API repository.
4. Complete the connection status until it is **Available**.

Do not use a GitHub personal access token in CodeBuild.

### 3.3 Deployment role

Create a CloudFormation deployment role that the CodePipeline deploy action can assume. For the first deployment, it needs permissions to create and update:

- the Lambda function and Function URL;
- the Lambda execution role and its inline policy;
- CloudWatch log group;
- Lambda permission resources;
- the stack's packaged S3 objects;
- CloudFormation stack resources.

Restrict the role after the first successful deployment to the application stack, Lambda function/role naming pattern, artifact bucket, and production secret ARN. It should not grant access to all Secrets Manager secrets.

## 4. Create CodePipeline and CodeBuild

1. Open **Developer Tools > CodePipeline > Pipelines > Create pipeline**.
2. Select a V2 pipeline if available, with the default pipeline service role.
3. In the **Source** stage:
   - Provider: GitHub (Version 2) / CodeConnections
   - Connection: the connection created above
   - Repository: the Mighty API GitHub repository
   - Branch: `main`
   - Change detection: enabled
4. Add a **Build** stage:
   - Provider: CodeBuild
   - Create a new project, for example `mighty-api-build`
   - Environment image: managed Linux image
   - Runtime: Node.js 20
   - Privileged mode: off
   - Buildspec: use `buildspec.yml` in the source repository
   - Environment variable: `ARTIFACT_BUCKET=<artifact-bucket-name>` (plain text; this is not secret)
   - Output artifact: for example `BuildOutput`
5. Ensure the CodeBuild service role can write only to the artifact bucket and CloudWatch Logs. It does not need access to the Mighty token.
6. Run the build stage once. It must produce `packaged.yaml`.

The included buildspec installs the SAM CLI into CodeBuild's user directory and invokes it by absolute path. The CodeBuild managed Linux image must include Python 3 and `pip`, which current AWS standard images do.

## 5. Add the CloudFormation Deploy Stage

After the build succeeds, edit the pipeline and add a deploy stage:

- Action provider: **CloudFormation**
- Action mode: **Create or update a stack**
- Input artifact: `BuildOutput`
- Template file: `packaged.yaml`
- Stack name: `mighty-api-production`
- Role name: the CloudFormation deployment role from step 3.3
- Capabilities: `CAPABILITY_IAM` and `CAPABILITY_AUTO_EXPAND`
- Parameter overrides:

```json
{
  "MightyApiSecretArn": "arn:aws:secretsmanager:<region>:<account-id>:secret:mighty-api/production-<suffix>",
  "MightyNetworkId": "<your-mighty-network-id>"
}
```

Use the exact secret ARN. The stack parameter is an ARN, not the token.

Run the pipeline. The expected result is:

```text
Source: success
Build: success
Deploy: success
```

If the deploy action reports `CodeUri is not a valid S3 Uri`, it was configured with `template.yaml`. Change the action to deploy the CodeBuild output's `packaged.yaml`.

## 6. Test the Deployed API and CORS

1. Open **CloudFormation > Stacks > mighty-api-production > Outputs**.
2. Copy `MightyApiUrl`.
3. Test health without exposing credentials:

```bash
curl -i "https://<function-url-id>.lambda-url.<region>.on.aws/health"
```

4. Test CORS for the production frontend:

```bash
curl -i \
  -H "Origin: https://patriotsinaction.com" \
  "https://<function-url-id>.lambda-url.<region>.on.aws/health"
```

The response must contain exactly one:

```text
Access-Control-Allow-Origin: https://patriotsinaction.com
```

5. Confirm an unapproved origin does not receive an `Access-Control-Allow-Origin` response header:

```bash
curl -i \
  -H "Origin: https://unapproved.example" \
  "https://<function-url-id>.lambda-url.<region>.on.aws/health"
```

6. Check **CloudWatch > Log groups** for the function. Never log the Mighty authorization header, full secret, or request configuration containing it.

## 7. Configure patriotsinaction.com

Set the frontend build environment variable to the API base URL:

```text
VITE_MIGHTY_PROXY=https://<function-url-id>.lambda-url.<region>.on.aws
```

There is no trailing slash because the existing frontend example appends route paths. Redeploy the frontend after changing the value.

Use endpoints such as:

```text
GET ${VITE_MIGHTY_PROXY}/health
GET ${VITE_MIGHTY_PROXY}/spaces?page=1&per_page=25
GET ${VITE_MIGHTY_PROXY}/spaces/<space-id>/feed?page=1&per_page=25
GET ${VITE_MIGHTY_PROXY}/spaces/<space-id>/events?page=1&per_page=50
```

The `VITE_MIGHTY_PROXY` value is public by design. The Mighty token must never be prefixed with `VITE_` because Vite embeds those values in browser JavaScript.

## 8. Optional: Stable Custom API Domain

Lambda Function URLs are acceptable for the initial deployment but are AWS-branded and can change if the function is recreated. For a stable public endpoint:

1. Request an ACM certificate in `us-east-1` for `api.patriotsinaction.com`.
2. Create a CloudFront distribution with the Lambda Function URL as its HTTPS origin.
3. Set the alternate domain name to `api.patriotsinaction.com`.
4. Add the Route 53 alias record to CloudFront.
5. Change the frontend variable to:

   ```text
   VITE_MIGHTY_PROXY=https://api.patriotsinaction.com
   ```

6. Keep Express as the only CORS layer and confirm the CloudFront behavior forwards `Origin` and `OPTIONS` requests.

Do not add this before the Function URL deployment is working; it introduces DNS, certificate, cache, and header-forwarding variables that complicate first-deployment troubleshooting.

## Troubleshooting

### Build cannot find `sam`

Use a CodeBuild image that includes the SAM CLI, or install a pinned SAM CLI version during the install phase. Confirm `sam --version` in the CodeBuild log.

### CloudFormation stack rolls back

Open **CloudFormation > mighty-api-production > Events** and inspect the first `CREATE_FAILED` or `UPDATE_FAILED` event. The later rollback entries do not identify the root cause.

If the stack is `ROLLBACK_COMPLETE`, delete that failed stack before trying a new create; CloudFormation cannot update it.

### API reports a missing Mighty configuration

Confirm the CloudFormation parameter overrides include `MightyNetworkId`; the function receives `MIGHTY_API_SECRET_ARN`; the Lambda role can read the exact secret ARN; and the secret JSON key is named `MIGHTY_API_KEY`.

### Browser reports a CORS error

Confirm the browser's exact `Origin` header is in `CORS_ORIGIN`, with no trailing slash. Check for duplicate `Access-Control-Allow-Origin` headers; remove Function URL/CloudFront CORS configuration if Express sets the headers.

### Function URL is publicly callable

This is expected for `AuthType: NONE`. CORS does not prevent scripts, curl, or other servers from calling it. Keep the API read-only, validate all pagination inputs, consider rate limiting/WAF when traffic grows, and never create an endpoint that proxies arbitrary Mighty API paths.

## Deployment Checklist

- [ ] A replacement Mighty token is stored only in Secrets Manager.
- [x] Lambda handler and runtime secret loading are implemented.
- [x] `template.yaml`, `buildspec.yml`, and `.env.example` are present, while `.env` is ignored.
- [ ] Artifact bucket is private, encrypted, and versioned.
- [ ] GitHub CodeConnection is available in the selected region.
- [ ] CodeBuild creates `packaged.yaml`.
- [ ] CloudFormation deploys `packaged.yaml`, not raw `template.yaml`.
- [ ] Lambda role can read only the production Mighty secret.
- [ ] `CORS_ORIGIN` contains the exact patriotsinaction.com origin(s).
- [ ] `/health` and browser CORS preflight succeed after deployment.
- [ ] `VITE_MIGHTY_PROXY` is set in the frontend and the frontend is redeployed.

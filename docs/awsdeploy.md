# AWS Console Deployment Walkthrough

This is the browser-only setup guide for deploying Mighty API from GitHub through CodePipeline, CodeBuild, CloudFormation/SAM, and a Lambda Function URL.

Use the same AWS region for every resource in this guide: Secrets Manager, S3, CodeConnections, CodeBuild, CodePipeline, CloudFormation, and Lambda. This guide uses `<region>` and `<account-id>` as placeholders.

## Before Opening CodePipeline

Make sure these repository files are committed and pushed to the GitHub `main` branch:

- `template.yaml`
- `buildspec.yml`
- `package.json` and `package-lock.json`
- `src/handler.ts` and the rest of `src/`

Do not commit `.env`, `.aws-sam`, `dist`, or the Mighty token.

Have these values ready:

| Value | Example / location |
| --- | --- |
| AWS region | One region chosen for all resources |
| Mighty network ID | The value currently used locally as `MIGHTY_NETWORK_ID` |
| Mighty token | A newly rotated token, if the existing one may have been exposed |
| Frontend origins | `https://patriotsinaction.com,https://www.patriotsinaction.com` |
| GitHub repository | `ErikBurdett/mighty-api` |

## 1. Create the Mighty Secret

1. In the AWS console, use the region picker in the upper-right corner to select your chosen region.
2. Open **Secrets Manager**.
3. Select **Store a new secret**.
4. Choose **Other type of secret**.
5. Under key/value pairs, enter:

   | Key | Value |
   | --- | --- |
   | `MIGHTY_API_KEY` | Your Mighty Networks Admin API token |

6. Select **Next**.
7. Set the secret name to:

   ```text
   mighty-api/production
   ```

8. Select **Next** through the rotation and review pages, then choose **Store**.
9. Open the created secret and copy its **Secret ARN**. It will look similar to:

   ```text
   arn:aws:secretsmanager:<region>:<account-id>:secret:mighty-api/production-<suffix>
   ```

Keep this ARN available. It is safe to use as a CloudFormation parameter; the token itself is not.

## 2. Create the SAM Artifact Bucket

CodeBuild uses this bucket to store the Lambda deployment package created by `sam package`.

1. Open **S3** and select **Create bucket**.
2. Enter a globally unique bucket name, for example:

   ```text
   mighty-api-artifacts-<account-id>-<region>
   ```

3. Select the same region chosen above.
4. Leave **Block all public access** enabled.
5. Enable **Bucket Versioning**.
6. Leave default encryption enabled, unless your AWS account requires a customer-managed KMS key.
7. Select **Create bucket**.

Do not make this bucket public. It contains deployment artifacts, not browser-accessible files.

## 3. Create the GitHub CodeConnection

1. Open **Developer Tools > Settings > Connections**.
2. Select **Create connection**.
3. For provider, choose **GitHub**.
4. Enter a connection name, for example:

   ```text
   mighty-api-github
   ```

5. Select **Connect to GitHub**.
6. In the GitHub authorization window, authorize the AWS Connector for GitHub app. Grant it access to the `ErikBurdett/mighty-api` repository.
7. Return to AWS and wait for the connection status to become **Available**.

Do not create a GitHub personal access token for CodeBuild. Use this AWS-managed connection.

## 4. Create the Pipeline — Starting From the Screen Shown

The screenshot shows **Deployment** selected and the **Deploy to CloudFormation** template highlighted.

Do **not** continue with that template. It would try to deploy the raw SAM template and skip the CodeBuild packaging step that produces `packaged.yaml`.

On the **Choose creation option** page:

1. Select the **Continuous integration** category at the top.
2. Select the **CI Build NodeJS** template.
3. Select **Next**.

If the exact template labels differ in the AWS console, create a V2 pipeline with:

```text
GitHub (CodeConnections) -> CodeBuild
```

Then add the CloudFormation deploy stage manually in step 6.

### Pipeline details

On the pipeline details page:

1. Pipeline name:

   ```text
   mighty-api-production
   ```

2. Keep the default option to create a new service role, unless your organization provides a dedicated CodePipeline service role.
3. Choose the default artifact store in the selected region, or select an existing encrypted artifact store if your organization requires one.
4. Continue to the source configuration.

### Source stage

Configure the source stage as follows:

| Field | Value |
| --- | --- |
| Source provider | GitHub (Version 2) |
| Connection | `mighty-api-github` |
| Repository name | `ErikBurdett/mighty-api` |
| Branch name | `main` |
| Output artifact format | Default |
| Start the pipeline on source code change | Enabled |

Select **Next**.

### Build stage

Create a new CodeBuild project:

| Field | Value |
| --- | --- |
| Project name | `mighty-api-build` |
| Environment image | Managed image |
| Compute | Small is sufficient initially |
| Operating system | Amazon Linux or Ubuntu managed image |
| Runtime | Standard |
| Node.js runtime | Node.js 20 |
| Privileged mode | Disabled |
| Buildspec | Use a buildspec file |
| Buildspec name | `buildspec.yml` |

Under **Additional configuration** or **Environment variables**, add:

| Name | Value | Type |
| --- | --- | --- |
| `ARTIFACT_BUCKET` | The bucket name created in step 2, without `s3://` | Plaintext |

Do not add `MIGHTY_API_KEY` to CodeBuild.

Keep the project outside a VPC unless a VPC is required. If it must run in a private VPC, it needs NAT gateway or equivalent outbound internet access for `npm ci`, installing the SAM CLI, and the AWS APIs.

Finish creating the CodeBuild project, then continue through the pipeline wizard. At this point, create the pipeline without a deployment provider if the wizard permits it. The CloudFormation deploy action is added in the next section.

## 5. Give CodeBuild Access to the Artifact Bucket

After the pipeline is created:

1. Open **CodeBuild > Build projects > mighty-api-build**.
2. Select the project, then choose **Edit > Service role** or open the linked service role in IAM.
3. Add a policy that permits that role to read and write only the artifact bucket from step 2:

   - `s3:ListBucket` on `arn:aws:s3:::<artifact-bucket-name>`
   - `s3:GetObject`, `s3:PutObject`, and `s3:AbortMultipartUpload` on `arn:aws:s3:::<artifact-bucket-name>/*`

4. Save the policy.

The CodeBuild role does not need permission to read the Mighty secret. Only the deployed Lambda function reads it.

## 6. Add the CloudFormation Deploy Stage

1. Open **CodePipeline > Pipelines > mighty-api-production**.
2. Select **Edit**.
3. After the CodeBuild stage, choose **Add stage**.
4. Stage name:

   ```text
   Deploy
   ```

5. Select **Add action group**.
6. Action name:

   ```text
   DeployMightyApi
   ```

7. Action provider: **AWS CloudFormation**.
8. Region: the same region used everywhere else.
9. Input artifact: select the CodeBuild output artifact (often named `BuildArtifact` or the name selected in the wizard).
10. Action mode: **Create or update a stack**.
11. Stack name:

    ```text
    mighty-api-production
    ```

12. Template:

    ```text
    BuildArtifact::packaged.yaml
    ```

    Replace `BuildArtifact` with the actual CodeBuild output artifact name. Do not select `template.yaml`.

13. Capabilities: enable:

    ```text
    CAPABILITY_IAM
    CAPABILITY_AUTO_EXPAND
    ```

14. In **Parameter overrides**, enter one compact JSON object:

    ```json
    {
      "MightyApiSecretArn": "arn:aws:secretsmanager:<region>:<account-id>:secret:mighty-api/production-<suffix>",
      "MightyNetworkId": "<your-mighty-network-id>",
      "CorsOrigin": "https://patriotsinaction.com,https://www.patriotsinaction.com"
    }
    ```

15. Select **Done**, then select **Save** to save the pipeline.

The CloudFormation deploy action uses the pipeline's CloudFormation role. If AWS asks for a role or deployment permissions, use a role that can create/update the stack, Lambda function, Function URL, Lambda execution role, CloudWatch Logs, and SAM deployment artifacts. Scope the final role to this application after the first successful deployment.

## 7. Run and Confirm the First Deployment

1. In CodePipeline, select **Release change**.
2. Watch the three stages:

   ```text
   Source -> Build -> Deploy
   ```

3. Open the **Build** action details if it fails. The CodeBuild log should show:

   ```text
   npm ci
   npm run typecheck
   sam validate
   npm run build
   sam build
   sam package
   ```

4. If the **Deploy** action fails, open **CloudFormation > Stacks > mighty-api-production > Events**.
5. Read the first `CREATE_FAILED` or `UPDATE_FAILED` event; later rollback events usually only report the consequence.

## 8. Get the Public API URL

1. Open **CloudFormation > Stacks > mighty-api-production**.
2. Open the **Outputs** tab.
3. Copy `MightyApiUrl`.
4. Test it in a terminal:

   ```bash
   curl -i "https://<function-url-id>.lambda-url.<region>.on.aws/health"
   ```

5. Verify CORS for the production site:

   ```bash
   curl -i \
     -H "Origin: https://patriotsinaction.com" \
     "https://<function-url-id>.lambda-url.<region>.on.aws/health"
   ```

The response should have one `Access-Control-Allow-Origin` header with `https://patriotsinaction.com`.

## 9. Connect patriotsinaction.com

In the frontend hosting provider's environment-variable settings, add:

```text
VITE_MIGHTY_PROXY=https://<function-url-id>.lambda-url.<region>.on.aws
```

Then redeploy the frontend. This is a public API URL and is safe to expose. Do not add the Mighty token to a `VITE_*` variable.

## Browser Troubleshooting

### The first screen only offers a deployment template

Go back to the category selector and choose **Continuous integration**, then **CI Build NodeJS**. The CloudFormation deployment action is added after the initial source/build pipeline exists.

### The build fails with `sam: command not found`

The supplied `buildspec.yml` installs SAM at `$HOME/.local/bin/sam`. Confirm the project uses the repository's latest `buildspec.yml`, uses a current managed Linux image, and has outbound internet access.

### CloudFormation reports `CodeUri is not a valid S3 Uri`

The deploy action is using raw `template.yaml`. Change the template field to the CodeBuild artifact's `packaged.yaml`.

### The Lambda reports missing Mighty configuration

Check that:

- the parameter override has the exact `MightyApiSecretArn`;
- the secret JSON key is `MIGHTY_API_KEY`;
- the parameter override includes `MightyNetworkId`;
- the Lambda role was created with permission to call `secretsmanager:GetSecretValue` for that secret.

### Browser requests fail with CORS

Compare the browser's exact `Origin` value to `CorsOrigin` in the pipeline parameter overrides. There must be no trailing slash. Do not configure Lambda Function URL CORS separately; Express already applies the CORS headers.

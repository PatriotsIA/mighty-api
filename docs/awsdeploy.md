# AWS Console Deployment Walkthrough

This is the browser-only setup guide for deploying Mighty API from GitHub through CodePipeline, CodeBuild, CloudFormation/SAM, and a Lambda Function URL.

Use the same AWS region for every resource in this guide: Secrets Manager, S3, CodeConnections, CodeBuild, CodePipeline, CloudFormation, and Lambda. This guide uses `<region>` and `<account-id>` as placeholders.

## Required Order

Complete the setup in this order:

1. Choose the AWS region and gather the required values.
2. Create the Mighty secret in Secrets Manager.
3. Create the private SAM artifact bucket.
4. Create the GitHub CodeConnection.
5. Verify, commit, and push the deployment source to GitHub `main`.
6. Create the CodePipeline and its CodeBuild project.
7. Add the CloudFormation deploy stage, then release the first change.

Do not create the pipeline from the raw, local files. CodePipeline reads the GitHub `main` branch, so the repository must contain the deployment files before the pipeline's first source action runs.

## 0. Choose the Region and Gather Values

Select one AWS region in the upper-right region picker and keep it selected for the rest of this guide. Have these values ready:

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

## 4. Verify, Commit, and Push the GitHub Source

Before creating CodePipeline, make sure the GitHub `main` branch contains:

- `template.yaml`
- `buildspec.yml`
- `package.json` and `package-lock.json`
- `src/handler.ts` and the rest of `src/`

Run these checks locally:

```bash
npm ci
npm run typecheck
npm run build
git ls-files .env
```

The final command must print nothing. Do not commit `.env`, `.aws-sam`, `dist`, or the Mighty token.

Commit and push the deployment work:

```bash
git add .gitignore .env.example README.md package.json package-lock.json src template.yaml buildspec.yml docs
git commit -m "prepare Mighty API for AWS deployment"
git push origin main
```

Confirm on GitHub that the `main` branch includes `template.yaml` and `buildspec.yml`. Only then continue to CodePipeline.

## 5. Create the Pipeline — Starting From the Screen Shown

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

Then add the CloudFormation deploy stage manually in step 7.

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
| Node.js runtime | Node.js 22 |
| Privileged mode | Disabled |
| Buildspec | Use a buildspec file |
| Buildspec name | `buildspec.yml` |

Under **Additional configuration** or **Environment variables**, add:

| Name | Value | Type |
| --- | --- | --- |
| `ARTIFACT_BUCKET` | The bucket name created in step 2, without `s3://` | Plaintext |

Do not add `MIGHTY_API_KEY` to CodeBuild.

Keep the project outside a VPC unless a VPC is required. If it must run in a private VPC, it needs NAT gateway or equivalent outbound internet access for `npm ci`, installing the SAM CLI, and the AWS APIs.

Under **Artifacts**:

| Field | Value |
| --- | --- |
| Artifact type | `CodePipeline` |

Do not leave the primary artifact type as **No artifacts**. CodePipeline needs the CodeBuild output so it can pass `packaged.yaml` to the CloudFormation deploy action.

Finish creating the CodeBuild project, then continue through the pipeline wizard. At this point, create the pipeline without a deployment provider if the wizard permits it. The CloudFormation deploy action is added in the next section.

### Required build-action output artifact

When editing the CodeBuild action in CodePipeline, the bottom **Output artifacts** field must not be empty. Enter:

```text
BuildOutput
```

Then select **Add**. This passes the `packaged.yaml` file produced by CodeBuild to the later CloudFormation action. Keep the source artifact selected as the build action's input artifact.

Do not add `ARTIFACT_BUCKET` in the CodePipeline action's optional environment-variable field. Configure it in the **CodeBuild project** environment variables as described above.

## 6. Give CodeBuild Access to the Artifact Bucket

After the pipeline is created:

1. Open **CodeBuild > Build projects > mighty-api-build**.
2. Select the project, then choose **Edit > Service role** or open the linked service role in IAM.
3. Confirm the role can read and write the SAM package bucket from step 2:

   - `s3:ListBucket` on `arn:aws:s3:::<artifact-bucket-name>`
   - `s3:GetObject`, `s3:PutObject`, and `s3:AbortMultipartUpload` on `arn:aws:s3:::<artifact-bucket-name>/*`

4. Add a separate inline policy that allows CodeBuild to publish the build output to the CodePipeline-managed artifact bucket. The role usually already has read permissions for this bucket; it must also have `s3:PutObject` for the `BuildOutput` artifact:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "WriteCodePipelineBuildOutput",
         "Effect": "Allow",
         "Action": [
           "s3:PutObject",
           "s3:AbortMultipartUpload"
         ],
         "Resource": "arn:aws:s3:::<codepipeline-artifact-bucket>/*"
       }
     ]
   }
   ```

   Find `<codepipeline-artifact-bucket>` in the existing CodeBuild role policies or the pipeline's **Settings** page. It is normally an automatically generated bucket with a name similar to `codepipelinestartertempla-codepipelineartifactsbuc-...`.

5. Save the policy.

The CodeBuild role does not need permission to read the Mighty secret. Only the deployed Lambda function reads it.

## 7. Create the CloudFormation Execution Role

Create a separate role for CloudFormation to assume while it creates and updates the application stack. Do not reuse the CodeBuild role.

1. Open **IAM > Roles > Create role**.
2. Choose **AWS service** as the trusted entity type.
3. Select **CloudFormation** as the use case, then choose **Next**.
4. Choose **Create policy**, open the **JSON** tab, and use this first-deployment policy:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "DeployMightyApiFirstRelease",
         "Effect": "Allow",
         "Action": [
           "cloudformation:*",
           "lambda:*",
           "iam:*",
           "logs:*",
           "s3:*"
         ],
         "Resource": "*"
       }
     ]
   }
   ```

5. Name the policy:

   ```text
   MightyApiFirstDeployPolicy
   ```

6. Return to the role-creation tab, refresh the policy list, attach `MightyApiFirstDeployPolicy`, and select **Next**.
7. Name the role:

   ```text
   MightyApiCloudFormationExecutionRole
   ```

8. Create the role and copy its ARN.

This broad policy is appropriate only for the first deployment while the exact generated Lambda and IAM resource names are unknown. Tighten it afterward to this application's CloudFormation stack, Lambda resources, artifact bucket, and secret.

The CodePipeline service role must also be allowed to pass this execution role to CloudFormation:

1. Open **CodePipeline > Pipelines > MightyAPI** and choose **Edit**.
2. In **Pipeline properties**, locate the **Service role**. Open the role link, or copy its name and open it through **IAM > Roles**. Do not use the CodeBuild role.
3. On the pipeline service role's **Permissions** tab, expand the existing policies and search for `iam:PassRole`. If a policy already allows `iam:PassRole` for `MightyApiCloudFormationExecutionRole` (or a broader role resource), no change is needed.
4. Otherwise, choose **Add permissions > Create inline policy > JSON**, then add this policy, replacing `<account-id>`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PassMightyApiCloudFormationRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::<account-id>:role/MightyApiCloudFormationExecutionRole",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "cloudformation.amazonaws.com"
        }
      }
    },
    {
      "Sid": "RunMightyApiCloudFormationDeploy",
      "Effect": "Allow",
      "Action": [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ValidateTemplate"
      ],
      "Resource": "*"
    }
  ]
}
```

5. Name the inline policy `PassMightyApiCloudFormationRole` and create it.

## 8. Add the CloudFormation Deploy Stage

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

15. In **Role name**, enter the ARN of `MightyApiCloudFormationExecutionRole`.
16. Select **Done**, then select **Save** to save the pipeline.

Do not leave **Role name** empty. The execution role creates and updates the stack, Lambda function, Function URL, Lambda execution role, CloudWatch Logs, and SAM deployment artifacts.

The **Parameter overrides** field accepts raw JSON only. Do not paste a Markdown language label such as `json`, triple backticks, comments, or placeholder values into that field.

## 9. Run and Confirm the First Deployment

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

## 10. Get the Public API URL

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

## 11. Connect patriotsinaction.com

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

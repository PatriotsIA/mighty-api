import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";

import type { CandidateRecord } from "../domain/types";

export class SubmissionEmailService {
  public constructor(
    private readonly fromEmail: string,
    private readonly toEmail: string,
    private readonly reviewPageUrl: string,
    private readonly client = new SESv2Client({ maxAttempts: 1 }),
  ) {}

  public async notify(record: CandidateRecord): Promise<void> {
    if (process.env.CANDIDATE_NOTIFICATIONS_ENABLED === "false") return;
    const text = [
      "A new candidate submission is ready for review.",
      "",
      `Submission ID: ${record.submissionId}`,
      `Candidate: ${record.candidate.name}`,
      `Office: ${record.candidate.office}`,
      `Submitted at: ${record.createdAt}`,
      "",
      `Review submission: ${this.reviewPageUrl}`,
    ].join("\n");

    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.fromEmail,
        Destination: {
          ToAddresses: [this.toEmail],
        },
        Content: {
          Simple: {
            Subject: {
              Data: "New candidate submission",
              Charset: "UTF-8",
            },
            Body: {
              Text: {
                Data: text,
                Charset: "UTF-8",
              },
            },
          },
        },
      }),
      { abortSignal: AbortSignal.timeout(3_000) },
    );
  }
}

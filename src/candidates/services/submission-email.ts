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
    const isChangeRequest = record.source === "change-request";
    const text = [
      isChangeRequest ? "A candidate profile change request is ready for private review." : "A new candidate submission is ready for review.",
      "",
      `Submission ID: ${record.submissionId}`,
      ...(isChangeRequest ? [`Original submission ID: ${record.changeRequest?.targetSubmissionId}`] : []),
      `Candidate: ${record.candidate.name}`,
      `Office: ${record.candidate.office}`,
      `Submitted at: ${record.createdAt}`,
      ...(record.submitter?.interviewRequested ? ["Requested: Interview with Patriots In Action"] : []),
      ...(record.submitter?.advertisingRequested ? ["Requested: Candidate advertising information"] : []),
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
              Data: isChangeRequest ? "Candidate profile change request" : "New candidate submission",
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

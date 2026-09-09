export const candidateScopes = ["statewide", "district", "county", "precinct", "city"] as const;
export const candidateStatuses = ["pending", "approved", "denied"] as const;
export const submitterRoles = ["candidate", "campaign", "volunteer", "party", "other"] as const;

export type CandidateScope = (typeof candidateScopes)[number];
export type CandidateStatus = (typeof candidateStatuses)[number];
export type SubmitterRole = (typeof submitterRoles)[number];

export interface CandidateProfile {
  id: string;
  name: string;
  office: string;
  stateSlug: string;
  scope: CandidateScope;
  officeLevel?: "local" | "state" | "federal";
  countySlugs?: string[];
  countySlug?: string;
  countyName?: string;
  district?: string;
  profileUrl?: string;
  party?: string;
  ballotpediaUrl?: string;
  email?: string;
  phone?: string;
  websiteUrl?: string;
  image?: string;
  videoEmbedUrl?: string;
  videoTitle?: string;
  bio?: string;
  electionYear?: number;
  incumbent?: boolean;
  facebookUrl?: string;
  xUrl?: string;
  instagramUrl?: string;
  youtubeUrl?: string;
}

export interface Submitter {
  submitterName: string;
  submitterEmail: string;
  submitterPhone?: string;
  submitterRole: SubmitterRole;
}

export interface Reviewer {
  sub: string;
  username?: string;
  email?: string;
}

export interface CandidateChangeRequest {
  targetSubmissionId: string;
  targetStatus: "pending" | "approved";
  targetRevision: number;
  baseCandidate: CandidateProfile;
  reason: string;
}

export interface CandidateRecord {
  submissionId: string;
  candidate: CandidateProfile;
  submitter?: Submitter;
  consent: boolean;
  attestation: boolean;
  source: "submission" | "seed" | "research" | "change-request";
  changeRequest?: CandidateChangeRequest;
  // Internal immutable idempotency key; never expose through any projection.
  inputFingerprint?: string;
  lastChangeRequest?: {
    submissionId: string;
    appliedAt: string;
    reviewer: Reviewer;
    previousRevision: number;
  };
  status: CandidateStatus;
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string;
  revision: number;
  reviewer?: Reviewer;
  reviewReason?: string;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

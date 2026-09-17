import { z } from "zod";

import { candidateScopes, candidateStatuses, submitterRoles } from "./types";
import { geographyIssue } from "./geography";
import { voterGuideIssues, type VoterGuideResponse } from "../../voter-guide/model";

export const voterGuideSchema = z.unknown().superRefine((value, context) => {
  for (const issue of voterGuideIssues(value)) context.addIssue({ code: "custom", ...issue });
}).transform((value) => value as VoterGuideResponse);

const emptyToUndefined = (value: unknown) => (value === "" ? undefined : value);

const shortText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.preprocess(emptyToUndefined, shortText(max).optional());
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must be a lowercase URL slug");
const email = z.string().trim().email().max(254);
const phone = z
  .string()
  .trim()
  .min(7)
  .max(40)
  .regex(/^[0-9+().\-\s]+$/, "Must be a valid phone number");
const httpUrl = z
  .string()
  .trim()
  .max(2_048)
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Only http and https URLs are allowed");
const optionalHttpUrl = z.preprocess(emptyToUndefined, httpUrl.optional());
const optionalEmail = z.preprocess(emptyToUndefined, email.optional());
const optionalPhone = z.preprocess(emptyToUndefined, phone.optional());
const imageReference = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(
    (value) =>
      (value.startsWith("/") &&
        !value.startsWith("//") &&
        !value.split("/").includes("..")) ||
      /^https?:\/\//i.test(value),
    "Must be an absolute site path or an http/https URL",
  );
const optionalImageReference = z.preprocess(emptyToUndefined, imageReference.optional());

export const candidateIdSchema = slug.max(100);

const candidateFields = {
  id: candidateIdSchema,
  name: shortText(120),
  office: shortText(200),
  stateSlug: slug,
  scope: z.enum(candidateScopes),
  officeLevel: z.enum(["local", "state", "federal"]).optional(),
  countySlugs: z.array(slug).max(254).refine((values) => new Set(values).size === values.length, "Choose each county once.").optional(),
  countySlug: z.preprocess(emptyToUndefined, slug.optional()),
  countyName: optionalText(120),
  district: optionalText(160),
  profileUrl: optionalHttpUrl,
  party: optionalText(80),
  ballotpediaUrl: optionalHttpUrl,
  email: optionalEmail,
  phone: optionalPhone,
  websiteUrl: optionalHttpUrl,
  image: optionalImageReference,
  videoEmbedUrl: optionalHttpUrl,
  videoTitle: optionalText(240),
  bio: optionalText(5_000),
  voterGuide: voterGuideSchema.optional(),
  electionYear: z.number().int().min(1900).max(2200).optional(),
  incumbent: z.boolean().optional(),
  facebookUrl: optionalHttpUrl,
  xUrl: optionalHttpUrl,
  instagramUrl: optionalHttpUrl,
  youtubeUrl: optionalHttpUrl,
} as const;

const candidateObjectSchema = z.object(candidateFields).strict();
export const candidateProfileSchema = candidateObjectSchema.refine((value) => !geographyIssue(value), {
  message: "Choose a valid state and matching county name/slug.",
  path: ["countySlug"],
});

const submissionCandidateSchema = candidateObjectSchema.extend({
  id: candidateIdSchema.optional(),
}).superRefine((value, context) => {
  const issue = geographyIssue(value);
  if (issue) context.addIssue({ code: "custom", message: issue, path: ["countySlug"] });
  if (["county", "precinct"].includes(value.scope) && !value.countySlug) {
    context.addIssue({ code: "custom", message: "Select a county for a county or precinct race.", path: ["countySlug"] });
  }
});

export const submitterSchema = z
  .object({
    submitterName: shortText(120),
    submitterEmail: email.transform((value) => value.toLowerCase()),
    submitterPhone: optionalPhone,
    submitterRole: z.enum(submitterRoles),
  })
  .strict();

export const candidateSubmissionSchema = z
  .object({
    candidate: submissionCandidateSchema,
    submitter: submitterSchema,
    consent: z.literal(true),
    attestation: z.literal(true),
    honeypot: z.literal("").optional(),
  })
  .strict();

const nullableOptionalText = (max: number) => shortText(max).nullable().optional();
const nullableOptionalHttpUrl = httpUrl.nullable().optional();
const nullableOptionalEmail = email.nullable().optional();
const nullableOptionalPhone = phone.nullable().optional();
const nullableOptionalImage = imageReference.nullable().optional();

export const candidatePatchSchema = z
  .object({
    name: shortText(120).optional(),
    office: shortText(200).optional(),
    stateSlug: slug.optional(),
    scope: z.enum(candidateScopes).optional(),
    officeLevel: z.enum(["local", "state", "federal"]).nullable().optional(),
    countySlugs: z.array(slug).max(254).refine((values) => new Set(values).size === values.length, "Choose each county once.").nullable().optional(),
    countySlug: slug.nullable().optional(),
    countyName: nullableOptionalText(120),
    district: nullableOptionalText(160),
    profileUrl: nullableOptionalHttpUrl,
    party: nullableOptionalText(80),
    ballotpediaUrl: nullableOptionalHttpUrl,
    email: nullableOptionalEmail,
    phone: nullableOptionalPhone,
    websiteUrl: nullableOptionalHttpUrl,
    image: nullableOptionalImage,
    videoEmbedUrl: nullableOptionalHttpUrl,
    videoTitle: nullableOptionalText(240),
    bio: nullableOptionalText(5_000),
    voterGuide: voterGuideSchema.nullable().optional(),
    electionYear: z.number().int().min(1900).max(2200).nullable().optional(),
    incumbent: z.boolean().nullable().optional(),
    facebookUrl: nullableOptionalHttpUrl,
    xUrl: nullableOptionalHttpUrl,
    instagramUrl: nullableOptionalHttpUrl,
    youtubeUrl: nullableOptionalHttpUrl,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one candidate field is required");

// References must be validated literally, not lowercased or trimmed into another ID.
export const changeReferenceSchema = z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must be a lowercase URL slug");
const changeRequestFields = {
  requestId: changeReferenceSchema,
  targetSubmissionId: changeReferenceSchema,
  reason: shortText(2_000),
  submitter: submitterSchema,
  consent: z.literal(true),
  attestation: z.literal(true),
  honeypot: z.literal(""),
};
export const changeRequestSchema = z.discriminatedUnion("targetStatus", [
  z.object({ ...changeRequestFields, targetStatus: z.literal("approved"), expectedTargetRevision: z.number().int().positive(), candidate: candidatePatchSchema }).strict(),
  // Reject a patch before any target lookup/merged-field validation: pending
  // profiles must not become a public field-validation oracle.
  z.object({ ...changeRequestFields, targetStatus: z.literal("pending"), expectedTargetRevision: z.number().int().positive().optional() }).strict(),
]);

export const submitterPatchSchema = z
  .object({
    submitterName: shortText(120).optional(),
    submitterEmail: email
      .transform((value) => value.toLowerCase())
      .optional(),
    submitterPhone: phone.nullable().optional(),
    submitterRole: z.enum(submitterRoles).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one submitter field is required");

export const adminPatchSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    candidate: candidatePatchSchema.optional(),
    submitter: submitterPatchSchema.optional(),
    reviewReason: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict()
  .refine((value) => value.candidate !== undefined || value.submitter !== undefined || value.reviewReason !== undefined, {
    message: "A candidate, submitter or review note update is required",
  });

export const approveSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: optionalText(2_000),
  })
  .strict();

export const denySchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    reason: shortText(2_000),
  })
  .strict();

export const publicListQuerySchema = z
  .object({
    stateSlug: slug.optional(),
    countySlug: slug.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
    cursor: z.string().max(2_048).optional(),
  })
  .strict().refine((query) => !query.countySlug || Boolean(query.stateSlug), { message: "A county filter requires a state.", path: ["stateSlug"] });

export const adminListQuerySchema = z
  .object({
    status: z.enum(candidateStatuses).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(2_048).optional(),
  })
  .strict();

export type CandidateSubmissionInput = z.infer<typeof candidateSubmissionSchema>;
export type CandidatePatchInput = z.infer<typeof candidatePatchSchema>;
export type SubmitterPatchInput = z.infer<typeof submitterPatchSchema>;

export const researchDraftSchema = z.object({ candidate: candidateProfileSchema, reviewReason: shortText(2000) }).strict();

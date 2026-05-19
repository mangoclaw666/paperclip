import { z } from "zod";
import {
  COMPANY_STATUSES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "../constants.js";

const logoAssetIdSchema = z.string().uuid().nullable().optional();
const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional();
const feedbackDataSharingTermsVersionSchema = z.string().min(1).nullable().optional();
const attachmentMaxBytesSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_COMPANY_ATTACHMENT_MAX_BYTES);

export const createCompanySchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
  attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
});

export type CreateCompany = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = createCompanySchema
  .partial()
  .extend({
    status: z.enum(COMPANY_STATUSES).optional(),
    spentMonthlyCents: z.number().int().nonnegative().optional(),
    requireBoardApprovalForNewAgents: z.boolean().optional(),
    feedbackDataSharingEnabled: z.boolean().optional(),
    feedbackDataSharingConsentAt: z.coerce.date().nullable().optional(),
    feedbackDataSharingConsentByUserId: z.string().min(1).nullable().optional(),
    feedbackDataSharingTermsVersion: feedbackDataSharingTermsVersionSchema,
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
    attachmentMaxBytes: attachmentMaxBytesSchema.optional(),
    sharedInstructions: z.string().nullable().optional(),
    bootstrapTemplate: z.string().nullable().optional(),
    heartbeatTemplate: z.string().nullable().optional(),
    // fork_mangoclaw: project + goal identifier prefix/counter (migration 0088).
    projectPrefix: z.string().nullable().optional(),
    projectCounter: z.number().int().nonnegative().optional(),
    goalPrefix: z.string().nullable().optional(),
    goalCounter: z.number().int().nonnegative().optional(),
  });

export type UpdateCompany = z.infer<typeof updateCompanySchema>;

export const updateCompanyBrandingSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    brandColor: brandColorSchema,
    logoAssetId: logoAssetIdSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined
      || value.description !== undefined
      || value.brandColor !== undefined
      || value.logoAssetId !== undefined,
    "At least one branding field must be provided",
  );

export type UpdateCompanyBranding = z.infer<typeof updateCompanyBrandingSchema>;

export const companyExternalSourceSchema = z.object({
  type: z.literal("filesystem"),
  rootPath: z.string().min(1),
  workspacePath: z.string().min(1).nullable().optional(),
  syncCommand: z.string().min(1).nullable().optional(),
  lastSyncedAt: z.string().datetime().nullable().optional(),
});

export const updateCompanyExternalSourceSchema = z.object({
  externalSource: companyExternalSourceSchema.nullable(),
});

export type UpdateCompanyExternalSource = z.infer<typeof updateCompanyExternalSourceSchema>;

export const companyOpenTargetSchema = z.object({
  target: z.enum(["hub", "workspace"]),
});

export type CompanyOpenTarget = z.infer<typeof companyOpenTargetSchema>;

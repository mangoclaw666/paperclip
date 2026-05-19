import type { CompanyStatus, PauseReason } from "../constants.js";

export interface CompanyExternalSource {
  type: "filesystem";
  rootPath: string;
  workspacePath?: string | null;
  syncCommand?: string | null;
  lastSyncedAt?: string | null;
}

export interface Company {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  issueCounter: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  attachmentMaxBytes: number;
  requireBoardApprovalForNewAgents: boolean;
  feedbackDataSharingEnabled: boolean;
  feedbackDataSharingConsentAt: Date | null;
  feedbackDataSharingConsentByUserId: string | null;
  feedbackDataSharingTermsVersion: string | null;
  brandColor: string | null;
  externalSource?: CompanyExternalSource | null;
  sharedInstructions?: string | null;
  bootstrapTemplate?: string | null;
  heartbeatTemplate?: string | null;
  logoAssetId: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

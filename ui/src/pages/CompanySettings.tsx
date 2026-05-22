import { ChangeEvent, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// fork_mangoclaw: eco-mode master toggle imports
import { agentsApi } from "../api/agents";
import { t } from "@/i18n";
import {
  DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES,
  MAX_COMPANY_ATTACHMENT_MAX_BYTES,
} from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { companiesApi } from "../api/companies";
import { accessApi } from "../api/access";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Settings, Check, Download, Upload } from "lucide-react";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import {
  Field,
  ToggleField,
  HintIcon,
} from "../components/agent-config-primitives";

type AgentSnippetInput = {
  onboardingTextUrl: string;
  connectionCandidates?: string[] | null;
  testResolutionUrl?: string | null;
};

const BYTES_PER_MIB = 1024 * 1024;
const DEFAULT_COMPANY_ATTACHMENT_MAX_MIB = DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
const MAX_COMPANY_ATTACHMENT_MAX_MIB = MAX_COMPANY_ATTACHMENT_MAX_BYTES / BYTES_PER_MIB;
export function CompanySettings() {
  const {
    companies,
    selectedCompany,
    selectedCompanyId,
    setSelectedCompanyId
  } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  // General settings local state
  const [companyName, setCompanyName] = useState("");
  const [description, setDescription] = useState("");
  const [brandColor, setBrandColor] = useState("");
  const [attachmentMaxMiB, setAttachmentMaxMiB] = useState(String(DEFAULT_COMPANY_ATTACHMENT_MAX_MIB));
  const [logoUrl, setLogoUrl] = useState("");
  const [logoUploadError, setLogoUploadError] = useState<string | null>(null);

  // Sync local state from selected company
  useEffect(() => {
    if (!selectedCompany) return;
    setCompanyName(selectedCompany.name);
    setDescription(selectedCompany.description ?? "");
    setBrandColor(selectedCompany.brandColor ?? "");
    setAttachmentMaxMiB(String(Math.round((selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES) / BYTES_PER_MIB)));
    setLogoUrl(selectedCompany.logoUrl ?? "");
  }, [selectedCompany]);

  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSnippet, setInviteSnippet] = useState<string | null>(null);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [snippetCopyDelightId, setSnippetCopyDelightId] = useState(0);

  const attachmentMaxBytes = Number.parseInt(attachmentMaxMiB, 10) * BYTES_PER_MIB;
  const attachmentMaxValid =
    Number.isInteger(attachmentMaxBytes)
    && attachmentMaxBytes >= BYTES_PER_MIB
    && attachmentMaxBytes <= MAX_COMPANY_ATTACHMENT_MAX_BYTES;

  const generalDirty =
    !!selectedCompany &&
    (companyName !== selectedCompany.name ||
      description !== (selectedCompany.description ?? "") ||
      brandColor !== (selectedCompany.brandColor ?? "") ||
      attachmentMaxBytes !== (selectedCompany.attachmentMaxBytes ?? DEFAULT_COMPANY_ATTACHMENT_MAX_BYTES));

  const generalMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string | null;
      brandColor: string | null;
      attachmentMaxBytes: number;
    }) => companiesApi.update(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  const settingsMutation = useMutation({
    mutationFn: (requireApproval: boolean) =>
      companiesApi.update(selectedCompanyId!, {
        requireBoardApprovalForNewAgents: requireApproval
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    }
  });

  // fork_mangoclaw: eco-mode master toggle — bulk PATCH ecoMode for all non-ceo agents.
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__no-company__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const nonCeoAgents = (agentsQuery.data ?? []).filter(
    (a) => a.role !== "ceo" && a.status !== "terminated"
  );
  const ecoModeStates = nonCeoAgents.map((a) => {
    const rc = (a.runtimeConfig ?? {}) as Record<string, unknown>;
    const hb = (rc.heartbeat ?? {}) as Record<string, unknown>;
    return hb.ecoMode === true;
  });
  const ecoAllOn = ecoModeStates.length > 0 && ecoModeStates.every(Boolean);
  const ecoAllOff = ecoModeStates.length > 0 && ecoModeStates.every((v) => !v);
  const ecoMixed = !ecoAllOn && !ecoAllOff && ecoModeStates.length > 0;

  const ecoMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      await Promise.all(
        nonCeoAgents.map((a) => {
          const rc = (a.runtimeConfig ?? {}) as Record<string, unknown>;
          const hb = (rc.heartbeat ?? {}) as Record<string, unknown>;
          const nextRuntimeConfig = {
            ...rc,
            heartbeat: { ...hb, ecoMode: enabled },
          };
          return agentsApi.update(a.id, { runtimeConfig: nextRuntimeConfig }, selectedCompanyId ?? undefined);
        })
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.agents.list(selectedCompanyId!),
      });
    },
  });

  const inviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createOpenClawInvitePrompt(selectedCompanyId!),
    onSuccess: async (invite) => {
      setInviteError(null);
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const absoluteUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;
      setSnippetCopied(false);
      setSnippetCopyDelightId(0);
      let snippet: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null
        });
      } catch {
        snippet = buildAgentSnippet({
          onboardingTextUrl: absoluteUrl,
          connectionCandidates: null,
          testResolutionUrl: null
        });
      }
      setInviteSnippet(snippet);
      try {
        await navigator.clipboard.writeText(snippet);
        setSnippetCopied(true);
        setSnippetCopyDelightId((prev) => prev + 1);
        setTimeout(() => setSnippetCopied(false), 2000);
      } catch {
        /* clipboard may not be available */
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.sidebarBadges(selectedCompanyId!)
      });
    },
    onError: (err) => {
      setInviteError(
        err instanceof Error ? err.message : t("companySettings.invites.createFailed", { defaultValue: "Failed to create invite" })
      );
    }
  });

  const syncLogoState = (nextLogoUrl: string | null) => {
    setLogoUrl(nextLogoUrl ?? "");
    void queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
  };

  const logoUploadMutation = useMutation({
    mutationFn: (file: File) =>
      assetsApi
        .uploadCompanyLogo(selectedCompanyId!, file)
        .then((asset) => companiesApi.update(selectedCompanyId!, { logoAssetId: asset.assetId })),
    onSuccess: (company) => {
      syncLogoState(company.logoUrl);
      setLogoUploadError(null);
    }
  });

  const clearLogoMutation = useMutation({
    mutationFn: () => companiesApi.update(selectedCompanyId!, { logoAssetId: null }),
    onSuccess: (company) => {
      setLogoUploadError(null);
      syncLogoState(company.logoUrl);
    }
  });

  function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!file) return;
    setLogoUploadError(null);
    logoUploadMutation.mutate(file);
  }

  function handleClearLogo() {
    clearLogoMutation.mutate();
  }

  useEffect(() => {
    setInviteError(null);
    setInviteSnippet(null);
    setSnippetCopied(false);
    setSnippetCopyDelightId(0);
  }, [selectedCompanyId]);

  const archiveMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.archive(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      if (nextCompanyId) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  // fork_mangoclaw: permanent delete mutation — wires DELETE /companies/:id with company-switch + cache refresh
  const deleteMutation = useMutation({
    mutationFn: ({
      companyId,
      nextCompanyId
    }: {
      companyId: string;
      nextCompanyId: string | null;
    }) => companiesApi.remove(companyId).then(() => ({ nextCompanyId })),
    onSuccess: async ({ nextCompanyId }) => {
      // nextCompanyId is null when the last company is deleted — leave selection
      // alone in that case (the page will redirect / show empty state).
      if (nextCompanyId !== null) {
        setSelectedCompanyId(nextCompanyId);
      }
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.all
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companies.stats
      });
    }
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? t("companySettings.breadcrumb.company", { defaultValue: "Company" }), href: "/dashboard" },
      { label: t("companySettings.breadcrumb.settings", { defaultValue: "Settings" }) }
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  function handleSaveGeneral() {
    generalMutation.mutate({
      name: companyName.trim(),
      description: description.trim() || null,
      brandColor: brandColor || null,
      attachmentMaxBytes
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("companySettings.title", { defaultValue: "Company Settings" })}</h1>
      </div>

      {/* General */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.general", { defaultValue: "General" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <Field
            label={t("companySettings.field.companyName", { defaultValue: "Company name" })}
            hint={t("companySettings.field.companyNameHint", { defaultValue: "The display name for your company." })}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
          </Field>
          <Field
            label={t("companySettings.field.description", { defaultValue: "Description" })}
            hint={t("companySettings.field.descriptionHint", { defaultValue: "Optional description shown in the company profile." })}
          >
            <input
              className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
              type="text"
              value={description}
              placeholder={t("companySettings.field.descriptionPlaceholder", { defaultValue: "Optional company description" })}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* Appearance */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.appearance", { defaultValue: "Appearance" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-start gap-4">
            <div className="shrink-0">
              <CompanyPatternIcon
                companyName={companyName || selectedCompany.name}
                logoUrl={logoUrl || null}
                brandColor={brandColor || null}
                className="rounded-[14px]"
              />
            </div>
            <div className="flex-1 space-y-3">
              <Field
                label={t("companySettings.field.logo", { defaultValue: "Logo" })}
                hint={t("companySettings.field.logoHint", { defaultValue: "Upload a PNG, JPEG, WEBP, GIF, or SVG logo image." })}
              >
                <div className="space-y-2">
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                    onChange={handleLogoFileChange}
                    className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none file:mr-4 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs"
                  />
                  {logoUrl && (
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClearLogo}
                        disabled={clearLogoMutation.isPending}
                      >
                        {clearLogoMutation.isPending ? t("companySettings.button.removing", { defaultValue: "Removing..." }) : t("companySettings.button.removeLogo", { defaultValue: "Remove logo" })}
                      </Button>
                    </div>
                  )}
                  {(logoUploadMutation.isError || logoUploadError) && (
                    <span className="text-xs text-destructive">
                      {logoUploadError ??
                        (logoUploadMutation.error instanceof Error
                          ? logoUploadMutation.error.message
                          : t("companySettings.button.logoUploadFailed", { defaultValue: "Logo upload failed" }))}
                    </span>
                  )}
                  {clearLogoMutation.isError && (
                    <span className="text-xs text-destructive">
                      {clearLogoMutation.error.message}
                    </span>
                  )}
                  {logoUploadMutation.isPending && (
                    <span className="text-xs text-muted-foreground">{t("companySettings.button.uploadingLogo", { defaultValue: "Uploading logo..." })}</span>
                  )}
                </div>
              </Field>
              <Field
                label={t("companySettings.field.brandColor", { defaultValue: "Brand color" })}
                hint={t("companySettings.field.brandColorHint", { defaultValue: "Sets the hue for the company icon. Leave empty for auto-generated color." })}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor || "#6366f1"}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                  />
                  <input
                    type="text"
                    value={brandColor}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "" || /^#[0-9a-fA-F]{0,6}$/.test(v)) {
                        setBrandColor(v);
                      }
                    }}
                    placeholder={t("companySettings.field.brandColorPlaceholder", { defaultValue: "Auto" })}
                    className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm font-mono outline-none"
                  />
                  {brandColor && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setBrandColor("")}
                      className="text-xs text-muted-foreground"
                    >
                      {t("companySettings.button.clear", { defaultValue: "Clear" })}
                    </Button>
                  )}
                </div>
              </Field>
              <Field
                label={t("companySettings.field.attachmentLimit", { defaultValue: "Attachment size limit" })}
                hint={t("companySettings.field.attachmentLimitHint", { defaultValue: `Accepted range: 1-${MAX_COMPANY_ATTACHMENT_MAX_MIB} MiB.`, max: MAX_COMPANY_ATTACHMENT_MAX_MIB })}
              >
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={MAX_COMPANY_ATTACHMENT_MAX_MIB}
                      step={1}
                      value={attachmentMaxMiB}
                      onChange={(e) => setAttachmentMaxMiB(e.target.value)}
                      className="w-28 rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none"
                    />
                    <span className="text-xs text-muted-foreground">MiB</span>
                  </div>
                  {!attachmentMaxValid && (
                    <span className="text-xs text-destructive">
                      {t("companySettings.field.attachmentLimitError", { defaultValue: `Enter a whole number from 1 to ${MAX_COMPANY_ATTACHMENT_MAX_MIB}.`, max: MAX_COMPANY_ATTACHMENT_MAX_MIB })}
                    </span>
                  )}
                </div>
              </Field>
            </div>
          </div>
        </div>
      </div>

      {/* Save button for General + Appearance */}
      {generalDirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSaveGeneral}
            disabled={generalMutation.isPending || !companyName.trim() || !attachmentMaxValid}
          >
            {generalMutation.isPending ? t("companySettings.button.saving", { defaultValue: "Saving..." }) : t("companySettings.button.save", { defaultValue: "Save changes" })}
          </Button>
          {generalMutation.isSuccess && (
            <span className="text-xs text-muted-foreground">{t("companySettings.button.saved", { defaultValue: "Saved" })}</span>
          )}
          {generalMutation.isError && (
            <span className="text-xs text-destructive">
              {generalMutation.error instanceof Error
                  ? generalMutation.error.message
                  : t("companySettings.button.saveFailed", { defaultValue: "Failed to save" })}
            </span>
          )}
        </div>
      )}

      {/* Hiring */}
      <div className="space-y-4" data-testid="company-settings-team-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.hiring", { defaultValue: "Hiring" })}
        </div>
        <div className="rounded-md border border-border px-4 py-3">
          <ToggleField
            label={t("companySettings.hiring.requireApproval", { defaultValue: "Require board approval for new hires" })}
            hint={t("companySettings.hiring.requireApprovalHint", { defaultValue: "New agent hires stay pending until approved by board." })}
            checked={!!selectedCompany.requireBoardApprovalForNewAgents}
            onChange={(v) => settingsMutation.mutate(v)}
            toggleTestId="company-settings-team-approval-toggle"
          />
        </div>
      </div>

      {/* Invites */}
      <div className="space-y-4" data-testid="company-settings-invites-section">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.invites", { defaultValue: "Invites" })}
        </div>
        <div className="space-y-3 rounded-md border border-border px-4 py-4">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">
              {t("companySettings.invites.generatePrompt", { defaultValue: "Generate an OpenClaw agent invite snippet." })}
            </span>
            <HintIcon text={t("companySettings.invites.generateHint", { defaultValue: "Creates a short-lived OpenClaw agent invite and renders a copy-ready prompt." })} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              data-testid="company-settings-invites-generate-button"
              size="sm"
              onClick={() => inviteMutation.mutate()}
              disabled={inviteMutation.isPending}
            >
              {inviteMutation.isPending
                ? t("companySettings.invites.generating", { defaultValue: "Generating..." })
                : t("companySettings.invites.generate", { defaultValue: "Generate OpenClaw Invite Prompt" })}
            </Button>
          </div>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}
          {inviteSnippet && (
            <div
              className="rounded-md border border-border bg-muted/30 p-2"
              data-testid="company-settings-invites-snippet"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-muted-foreground">
                  {t("companySettings.invites.snippetTitle", { defaultValue: "OpenClaw Invite Prompt" })}
                </div>
                {snippetCopied && (
                  <span
                    key={snippetCopyDelightId}
                    className="flex items-center gap-1 text-xs text-green-600 animate-pulse"
                  >
                    <Check className="h-3 w-3" />
                    {t("companySettings.invites.copied", { defaultValue: "Copied" })}
                  </span>
                )}
              </div>
              <div className="mt-1 space-y-1.5">
                <textarea
                  data-testid="company-settings-invites-snippet-textarea"
                  className="h-[28rem] w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none"
                  value={inviteSnippet}
                  readOnly
                />
                <div className="flex justify-end">
                  <Button
                    data-testid="company-settings-invites-copy-button"
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(inviteSnippet);
                        setSnippetCopied(true);
                        setSnippetCopyDelightId((prev) => prev + 1);
                        setTimeout(() => setSnippetCopied(false), 2000);
                      } catch {
                        /* clipboard may not be available */
                      }
                    }}
                  >
                    {snippetCopied ? t("companySettings.invites.copiedSnippet", { defaultValue: "Copied snippet" }) : t("companySettings.invites.copySnippet", { defaultValue: "Copy snippet" })}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* fork_mangoclaw: Eco Mode master toggle — bulk on/off for non-Director agents */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.ecoMode", { defaultValue: "Eco Mode" })}
        </div>
        <div className="rounded-md border border-border px-4 py-4 space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium">
                {t("companySettings.ecoMode.title", { defaultValue: "Skip wake when nothing changed" })}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t("companySettings.ecoMode.description", { defaultValue: "Master switch for all non-Director agents. When ON, idle agents skip the LLM call on timer wake if no relevant change happened since the last cycle. Saves cost for idle agents. Director is always excluded so autonomous cascade keeps running." })}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {ecoMutation.isPending ? (
                <span className="text-xs text-muted-foreground">{t("companySettings.ecoMode.updating", { defaultValue: "Updating…" })}</span>
              ) : ecoMixed ? (
                <span className="text-xs text-amber-600">{t("companySettings.ecoMode.mixed", { defaultValue: "Mixed" })}</span>
              ) : null}
              <Button
                size="sm"
                variant={ecoAllOn ? "default" : "outline"}
                disabled={ecoMutation.isPending || nonCeoAgents.length === 0}
                onClick={() => ecoMutation.mutate(true)}
              >
                {ecoAllOn ? <Check className="mr-1 h-3 w-3" /> : null}
                {t("companySettings.ecoMode.turnOnAll", { defaultValue: "Turn ON all" })}
              </Button>
              <Button
                size="sm"
                variant={ecoAllOff ? "default" : "outline"}
                disabled={ecoMutation.isPending || nonCeoAgents.length === 0}
                onClick={() => ecoMutation.mutate(false)}
              >
                {ecoAllOff ? <Check className="mr-1 h-3 w-3" /> : null}
                {t("companySettings.ecoMode.turnOffAll", { defaultValue: "Turn OFF all" })}
              </Button>
            </div>
          </div>
          {nonCeoAgents.length > 0 ? (
            <div className="text-xs text-muted-foreground border-t border-border pt-3">
              <div className="font-medium mb-1.5">{t("companySettings.ecoMode.affected", { defaultValue: `Affected agents (${nonCeoAgents.length}):`, count: nonCeoAgents.length })}</div>
              <div className="grid grid-cols-2 gap-y-1 gap-x-4">
                {nonCeoAgents.map((a, i) => (
                  <div key={a.id} className="flex items-center gap-2">
                    <span
                      className={
                        ecoModeStates[i]
                          ? "inline-block h-1.5 w-1.5 rounded-full bg-green-500"
                          : "inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
                      }
                    />
                    <span>{a.name}</span>
                    <span className="text-muted-foreground/60">
                      ({ecoModeStates[i] ? t("companySettings.ecoMode.on", { defaultValue: "eco ON" }) : t("companySettings.ecoMode.off", { defaultValue: "eco OFF" })})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : agentsQuery.isLoading ? (
            <div className="text-xs text-muted-foreground">{t("companySettings.ecoMode.loadingAgents", { defaultValue: "Loading agents…" })}</div>
          ) : (
            <div className="text-xs text-muted-foreground">{t("companySettings.ecoMode.noAgents", { defaultValue: "No non-Director agents to toggle." })}</div>
          )}
          {ecoMutation.isError && (
            <div className="text-xs text-destructive">
              {t("companySettings.ecoMode.updateFailed", { defaultValue: "Failed to update eco mode" })}:{" "}
              {ecoMutation.error instanceof Error ? ecoMutation.error.message : t("companySettings.ecoMode.unknownError", { defaultValue: "unknown error" })}
            </div>
          )}
        </div>
      </div>

      {/* Import / Export */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {t("companySettings.section.companyPackages", { defaultValue: "Company Packages" })}
        </div>
        <div className="rounded-md border border-border px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("companySettings.packages.description", { defaultValue: "Import and export have moved to dedicated pages accessible from the Org Chart header." })}{" "}
            <a href="/org" className="underline hover:text-foreground">{t("companySettings.packages.orgChartLink", { defaultValue: "Org Chart" })}</a>
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href="/company/export">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.packages.export", { defaultValue: "Export" })}
              </a>
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/company/import">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {t("companySettings.packages.import", { defaultValue: "Import" })}
              </a>
            </Button>
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="space-y-4">
        <div className="text-xs font-medium text-destructive uppercase tracking-wide">
          {t("companySettings.section.dangerZone", { defaultValue: "Danger Zone" })}
        </div>
        <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
          <p className="text-sm text-muted-foreground">
            {t("companySettings.dangerZone.description", { defaultValue: "Archive this company to hide it from the sidebar. This persists in the database." })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={
                archiveMutation.isPending ||
                selectedCompany.status === "archived"
              }
              onClick={() => {
                if (!selectedCompanyId) return;
                const confirmed = window.confirm(
                  t("companySettings.dangerZone.confirmArchive", { defaultValue: `Archive company "${selectedCompany.name}"? It will be hidden from the sidebar.`, name: selectedCompany.name })
                );
                if (!confirmed) return;
                const nextCompanyId =
                  companies.find(
                    (company) =>
                      company.id !== selectedCompanyId &&
                      company.status !== "archived"
                  )?.id ?? null;
                archiveMutation.mutate({
                  companyId: selectedCompanyId,
                  nextCompanyId
                });
              }}
            >
              {archiveMutation.isPending
                ? t("companySettings.dangerZone.archiving", { defaultValue: "Archiving..." })
                : selectedCompany.status === "archived"
                ? t("companySettings.dangerZone.alreadyArchived", { defaultValue: "Already archived" })
                : t("companySettings.dangerZone.archive", { defaultValue: "Archive company" })}
            </Button>
            {archiveMutation.isError && (
              <span className="text-xs text-destructive">
                {archiveMutation.error instanceof Error
                  ? archiveMutation.error.message
                  : t("companySettings.dangerZone.archiveFailed", { defaultValue: "Failed to archive company" })}
              </span>
            )}
          </div>

          {/* fork_mangoclaw: permanent delete — separated from archive with stronger 2-step confirm */}
          <div className="mt-4 border-t border-destructive/30 pt-3">
            <p className="text-sm text-muted-foreground">
              {t("companySettings.dangerZone.deleteDescription", { defaultValue: "Permanently delete this company and ALL its data (agents, issues, runs, secrets). This cannot be undone." })}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={deleteMutation.isPending}
                onClick={() => {
                  if (!selectedCompanyId) return;
                  const first = window.confirm(
                    t("companySettings.dangerZone.confirmDelete1", { defaultValue: `Permanently DELETE company "${selectedCompany.name}" and all its data? This cannot be undone.`, name: selectedCompany.name })
                  );
                  if (!first) return;
                  const second = window.confirm(
                    t("companySettings.dangerZone.confirmDelete2", { defaultValue: `Last warning: All agents, issues, runs, secrets, and activity for "${selectedCompany.name}" will be permanently lost. Proceed?`, name: selectedCompany.name })
                  );
                  if (!second) return;
                  const nextCompanyId =
                    companies.find(
                      (company) => company.id !== selectedCompanyId
                    )?.id ?? null;
                  deleteMutation.mutate({
                    companyId: selectedCompanyId,
                    nextCompanyId
                  });
                }}
              >
                {deleteMutation.isPending
                  ? t("companySettings.dangerZone.deleting", { defaultValue: "Deleting..." })
                  : t("companySettings.dangerZone.delete", { defaultValue: "Delete company permanently" })}
              </Button>
              {deleteMutation.isError && (
                <span className="text-xs text-destructive">
                  {deleteMutation.error instanceof Error
                    ? deleteMutation.error.message
                    : t("companySettings.dangerZone.deleteFailed", { defaultValue: "Failed to delete company" })}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function buildAgentSnippet(input: AgentSnippetInput) {
  const candidateUrls = buildCandidateOnboardingUrls(input);
  const resolutionTestUrl = buildResolutionTestUrl(input);

  const candidateList =
    candidateUrls.length > 0
      ? candidateUrls.map((u) => `- ${u}`).join("\n")
      : "- (No candidate URLs available yet.)";

  const connectivityBlock =
    candidateUrls.length === 0
      ? `No candidate URLs are available. Ask your user to configure a reachable hostname in Paperclip, then retry.
Suggested steps:
- choose a hostname that resolves to the Paperclip host from your runtime
- run: pnpm paperclipai allowed-hostname <host>
- restart Paperclip
- verify with: curl -fsS http://<host>:3100/api/health
- regenerate this invite snippet`
      : `If none are reachable, ask your user to add a reachable hostname in Paperclip, restart, and retry.
Suggested command:
- pnpm paperclipai allowed-hostname <host>
Then verify with: curl -fsS <base-url>/api/health`;

  const resolutionLine = resolutionTestUrl
    ? `\nYou MUST test Paperclip-to-gateway reachability, call: ${resolutionTestUrl}?url=<urlencoded-gateway-url> (using the hostname that worked above). Do not assume your 172.x is necessarily reachable from Paperclip. Test it. `
    : "";

  return `You're invited to join a Paperclip organization.

The URLs you should try are:
${candidateList}

Connectivity guidance:
If you are running on a different machine than Paperclip, Paperclip must be reachable at one of the hostnames used above.
Verify the hostname works from your runtime with: GET <base-url>/api/health

${connectivityBlock}

For your "agentName", just use your own agent name (OpenClaw or whatever your name is) and send it directly.
You also need to send a gateway URL that Paperclip can access. Check your config and include that URL.${resolutionLine}

---

This onboarding flow is for OpenClaw Gateway.
When you submit the join request, use:
- \`adapterType: "openclaw_gateway"\`
- \`agentDefaultsPayload.url\` as your \`ws://\` or \`wss://\` gateway URL
- \`agentDefaultsPayload.headers["x-openclaw-token"]\` with your gateway token
- (legacy accepted) \`agentDefaultsPayload.headers["x-openclaw-auth"]\`
- Keep device auth enabled (recommended). If \`devicePrivateKeyPem\` is omitted, Paperclip will generate and persist one during join so pairing approvals remain stable.
- Only use \`disableDeviceAuth=true\` for special environments where pairing cannot be completed.

Do NOT use \`/v1/responses\` or \`/hooks/*\` in this join flow.

Before you do anything, please respond to your user that you understand the instructions and you're going to work on them. Then do the step above in another session called "paperclip-onboarding" and then tell your user when you're done. Update your user in intermediate steps along the way so they know what's going on.

Then after you've connected to Paperclip (exchanged keys etc.) you MUST review and follow the onboarding instructions in onboarding.txt they give you.

`;
}

function buildCandidateOnboardingUrls(input: AgentSnippetInput): string[] {
  const candidates = (input.connectionCandidates ?? [])
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  const urls = new Set<string>();
  let onboardingUrl: URL | null = null;

  try {
    onboardingUrl = new URL(input.onboardingTextUrl);
    urls.add(onboardingUrl.toString());
  } catch {
    const trimmed = input.onboardingTextUrl.trim();
    if (trimmed) {
      urls.add(trimmed);
    }
  }

  if (!onboardingUrl) {
    for (const candidate of candidates) {
      urls.add(candidate);
    }
    return Array.from(urls);
  }

  const onboardingPath = `${onboardingUrl.pathname}${onboardingUrl.search}`;
  for (const candidate of candidates) {
    try {
      const base = new URL(candidate);
      urls.add(`${base.origin}${onboardingPath}`);
    } catch {
      urls.add(candidate);
    }
  }

  return Array.from(urls);
}

function buildResolutionTestUrl(input: AgentSnippetInput): string | null {
  const explicit = input.testResolutionUrl?.trim();
  if (explicit) return explicit;

  try {
    const onboardingUrl = new URL(input.onboardingTextUrl);
    const testPath = onboardingUrl.pathname.replace(
      /\/onboarding\.txt$/,
      "/test-resolution"
    );
    return `${onboardingUrl.origin}${testPath}`;
  } catch {
    return null;
  }
}

import { useTranslation } from "@/i18n";
import { cn } from "../lib/utils";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";

export function StatusBadge({ status, ns }: { status: string; ns?: "issue" | "project" | "goal" }) {
  const { t } = useTranslation();
  const key = ns ? `enum.status.${ns}.${status}` : `enum.status.issue.${status}`;
  const fallback = status.replace(/_/g, " ");
  const label = t(key, { defaultValue: fallback });

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0",
        statusBadge[status] ?? statusBadgeDefault
      )}
    >
      {label}
    </span>
  );
}

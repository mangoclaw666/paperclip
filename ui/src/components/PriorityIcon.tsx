import { useState } from "react";
import { ArrowUp, ArrowDown, Minus, AlertTriangle } from "lucide-react";
import { cn } from "../lib/utils";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

const priorityConfig: Record<string, { icon: typeof ArrowUp; color: string; labelKey: string; fallback: string }> = {
  critical: { icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault, labelKey: "enum.priority.critical", fallback: "Critical" },
  high: { icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault, labelKey: "enum.priority.high", fallback: "High" },
  medium: { icon: Minus, color: priorityColor.medium ?? priorityColorDefault, labelKey: "enum.priority.medium", fallback: "Medium" },
  low: { icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault, labelKey: "enum.priority.low", fallback: "Low" },
};

const allPriorities = ["critical", "high", "medium", "low"];

interface PriorityIconProps {
  priority: string;
  onChange?: (priority: string) => void;
  className?: string;
  showLabel?: boolean;
}

export function PriorityIcon({ priority, onChange, className, showLabel }: PriorityIconProps) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const config = priorityConfig[priority] ?? priorityConfig.medium!;
  const Icon = config.icon;
  const label = t(config.labelKey, { defaultValue: config.fallback });

  const icon = (
    <span
      className={cn(
        "inline-flex items-center justify-center shrink-0",
        config.color,
        onChange && !showLabel && "cursor-pointer",
        className
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );

  if (!onChange) return showLabel ? <span className="inline-flex items-center gap-1.5">{icon}<span className="text-sm">{label}</span></span> : icon;

  const trigger = showLabel ? (
    <button className="inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 py-0.5 transition-colors">
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  ) : icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start">
        {allPriorities.map((p) => {
          const c = priorityConfig[p]!;
          const PIcon = c.icon;
          const pLabel = t(c.labelKey, { defaultValue: c.fallback });
          return (
            <Button
              key={p}
              variant="ghost"
              size="sm"
              className={cn("w-full justify-start gap-2 text-xs", p === priority && "bg-accent")}
              onClick={() => {
                onChange(p);
                setOpen(false);
              }}
            >
              <PIcon className={cn("h-3.5 w-3.5", c.color)} />
              {pLabel}
            </Button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}

import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from "lucide-react";

import { cn } from "@/lib/utils";

type AlertVariant = "info" | "warning" | "error" | "success";

const icons = {
  info: Info,
  warning: AlertTriangle,
  error: OctagonAlert,
  success: CheckCircle2,
};

const styles: Record<AlertVariant, string> = {
  info: "border-primary/25 bg-primary/10 text-foreground [&_.alert-icon]:text-primary",
  warning: "border-warning/30 bg-warning/10 text-foreground [&_.alert-icon]:text-warning",
  error:
    "border-destructive/30 bg-destructive/10 text-foreground [&_.alert-icon]:text-destructive",
  success: "border-success/30 bg-success/10 text-foreground [&_.alert-icon]:text-success",
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: AlertVariant;
  title?: string;
  action?: React.ReactNode;
}

export function Alert({
  className,
  variant = "info",
  title,
  action,
  children,
  ...props
}: AlertProps) {
  const Icon = icons[variant];
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-lg border p-3 text-xs leading-relaxed",
        styles[variant],
        className,
      )}
      {...props}
    >
      <Icon className="alert-icon mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <div className="font-medium text-foreground">{title}</div> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

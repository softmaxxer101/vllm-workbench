import { cn } from "@/lib/utils";

export function PageHeader({
  index,
  eyebrow,
  title,
  description,
  actions,
  children,
  className,
}: {
  index?: string;
  eyebrow?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-6 sm:mb-8", className)}>
      <div className="flex flex-col gap-5 border-b border-border/80 pb-6 lg:flex-row lg:items-end lg:justify-between lg:gap-10 lg:pb-7">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 font-mono text-[9px] uppercase tracking-[0.24em] text-muted-foreground">
            {index ? <span className="text-primary">{index}</span> : null}
            <span className="h-px w-7 bg-border" />
            <span>{eyebrow}</span>
          </div>
          <h1 className="mt-3 max-w-3xl font-display text-[40px] leading-[0.98] tracking-[-0.015em] text-foreground sm:text-[50px] lg:text-[56px]">
            {title}
          </h1>
          {description ? (
            <p className="mt-3 max-w-2xl text-[12.5px] leading-6 text-muted-foreground sm:text-[13.5px]">
              {description}
            </p>
          ) : null}
          {children}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end lg:pb-1">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}

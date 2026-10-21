"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BookOpen,
  Columns2,
  Cpu,
  Keyboard,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";

import { API_BASE } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EnginePill } from "./engine-status";
import { LiveLoadStrip } from "./live-load-strip";
import { ThemeToggle } from "./theme-toggle";
import { ShortcutsDialog } from "./shortcuts-dialog";

const NAV = [
  { href: "/", label: "Playground", icon: Sparkles, key: "p" },
  { href: "/compare", label: "Compare", icon: Columns2, key: "c" },
  { href: "/sweep", label: "Sweep", icon: SlidersHorizontal, key: "s" },
  { href: "/metrics", label: "Metrics", icon: Activity, key: "m" },
  { href: "/server", label: "Server", icon: Cpu, key: "e" },
];

const ROUTES: Record<string, string> = {
  p: "/",
  c: "/compare",
  s: "/sweep",
  m: "/metrics",
  e: "/server",
};

function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 36 36"
      aria-hidden="true"
      className={cn("size-8 shrink-0", className)}
      fill="none"
    >
      <rect x="1" y="1" width="34" height="34" rx="8" fill="hsl(var(--foreground))" />
      <path d="M8 11h14v2.2H8zm0 5.4h20v2.2H8zm0 5.4h9v2.2H8z" fill="hsl(var(--background))" />
      <rect x="25" y="23.8" width="4.2" height="4.2" fill="hsl(var(--primary))" />
    </svg>
  );
}

function NavLink({
  item,
  index,
  active,
  mobile = false,
  onNavigate,
}: {
  item: (typeof NAV)[number];
  index: number;
  active: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;

  if (mobile) {
    return (
      <Link
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex flex-1 flex-col items-center gap-1 py-2 font-mono text-[9px] uppercase tracking-[0.12em] transition-colors",
          active ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
        )}
      >
        {active ? (
          <span className="absolute inset-x-4 top-0 h-px bg-primary shadow-[0_0_10px_hsl(var(--primary))]" />
        ) : null}
        <Icon
          className={cn("size-[17px]", active && "text-primary")}
          strokeWidth={active ? 2.2 : 1.7}
        />
        {item.label}
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-full items-center gap-1.5 px-3 font-mono text-[10px] uppercase tracking-[0.16em] transition-colors",
        active ? "text-foreground" : "text-muted-foreground/75 hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "text-[8px] tabular-nums transition-colors",
          active ? "text-primary" : "text-muted-foreground/35 group-hover:text-muted-foreground",
        )}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      {item.label}
      <span
        className={cn(
          "absolute inset-x-3 bottom-0 h-px origin-left bg-primary transition-transform duration-200",
          active ? "scale-x-100" : "scale-x-0 group-hover:scale-x-50",
        )}
      />
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  useEffect(() => {
    let chord = false;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        target?.isContentEditable;

      if (typing) return;

      if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("workbench:focus-composer"));
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent("workbench:focus-composer"));
        return;
      }
      if (event.key.toLowerCase() === "g") {
        chord = true;
        if (chordTimer) clearTimeout(chordTimer);
        chordTimer = setTimeout(() => {
          chord = false;
        }, 900);
        return;
      }
      if (chord && ROUTES[event.key.toLowerCase()]) {
        event.preventDefault();
        chord = false;
        router.push(ROUTES[event.key.toLowerCase()]);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (chordTimer) clearTimeout(chordTimer);
    };
  }, [router]);

  return (
    <div className="relative isolate min-h-dvh">
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="grid-overlay absolute inset-0 opacity-50" />
        <div className="absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-background/20 via-background/60 to-background" />
      </div>

      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[62px] w-full max-w-[1500px] items-center gap-4 px-4 sm:px-6 lg:h-[70px] lg:px-8">
          <Link
            href="/"
            className="group flex shrink-0 items-center gap-2.5"
            aria-label="vLLM Workbench home"
          >
            <BrandMark className="size-[30px] transition-transform duration-300 group-hover:-rotate-3 lg:size-8" />
            <span className="flex flex-col">
              <span className="font-display text-[23px] leading-none tracking-[-0.01em] lg:text-[26px]">
                Workbench
              </span>
              <span className="mt-1 hidden font-mono text-[7px] uppercase tracking-[0.28em] text-muted-foreground sm:block">
                vLLM inference lab
              </span>
            </span>
          </Link>

          <LiveLoadStrip className="ml-1 mr-2" />

          <nav
            className="hidden h-full flex-1 items-stretch justify-center lg:flex"
            aria-label="Primary"
          >
            {NAV.map((item, index) => (
              <NavLink key={item.href} item={item} index={index} active={isActive(item.href)} />
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-1.5">
            <EnginePill className="mr-1" />
            <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
            <div className="hidden items-center gap-0.5 sm:flex">
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={`${API_BASE}/docs`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open API documentation"
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                  >
                    <BookOpen className="size-[15px]" />
                  </a>
                </TooltipTrigger>
                <TooltipContent>Backend API docs</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setShortcutsOpen(true)}
                    aria-label="Keyboard shortcuts"
                    className="size-8"
                  >
                    <Keyboard className="size-[15px]" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Shortcuts · ?</TooltipContent>
              </Tooltip>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-[1500px] px-4 pb-28 pt-6 sm:px-6 sm:pt-8 lg:px-8 lg:pb-14 lg:pt-10">
        {children}
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border/80 bg-background/90 px-2 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-0.5 backdrop-blur-xl lg:hidden"
        aria-label="Primary mobile"
      >
        {NAV.map((item, index) => (
          <NavLink
            key={item.href}
            item={item}
            index={index}
            active={isActive(item.href)}
            mobile
            onNavigate={() => window.scrollTo({ top: 0 })}
          />
        ))}
      </nav>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

export { BrandMark };

"use client";

import { Command } from "lucide-react";

import { useModKey } from "@/hooks/use-mod-key";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function shortcutGroups(mod: string) {
  return [
  {
    title: "Chat",
    items: [
      { keys: [mod, "Enter"], label: "Send message" },
      { keys: [mod, "K"], label: "Focus the composer" },
      { keys: ["/"], label: "Focus the composer" },
      { keys: ["Esc"], label: "Stop streaming" },
      { keys: [mod, "Shift", "K"], label: "Clear the conversation" },
    ],
  },
  {
    title: "Navigate",
    items: [
      { keys: ["G", "P"], label: "Playground" },
      { keys: ["G", "C"], label: "Compare" },
      { keys: ["G", "S"], label: "Parameter sweep" },
      { keys: ["G", "M"], label: "Metrics" },
      { keys: ["G", "E"], label: "Server" },
    ],
  },
  {
    title: "General",
    items: [
      { keys: ["?"], label: "Show this reference" },
      { keys: ["Esc"], label: "Close dialogs" },
    ],
  },
  ];
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const modKey = useModKey();
  const groups = shortcutGroups(modKey);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Command className="size-4 text-primary" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Move through the workbench without leaving the keyboard.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.title}>
              <p className="label-caps mb-2">{group.title}</p>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <div
                    key={item.label}
                    className="flex items-center justify-between rounded-md px-1.5 py-1.5 text-xs odd:bg-muted/20"
                  >
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="flex items-center gap-1">
                      {item.keys.map((key, index) => (
                        <span key={`${key}-${index}`} className="flex items-center gap-1">
                          {index > 0 && (
                            <span className="text-[9px] text-muted-foreground/60">+</span>
                          )}
                          <kbd className="kbd">{key}</kbd>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

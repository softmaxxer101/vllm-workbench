"use client";

import { useEffect, useState } from "react";

/** Platform-aware modifier label, resolved after hydration. */
export function useModKey(): string {
  const [mod, setMod] = useState("Ctrl");
  useEffect(() => {
    const platform = navigator.platform || navigator.userAgent;
    setMod(/Mac|iPod|iPhone|iPad/.test(platform) ? "⌘" : "Ctrl");
  }, []);
  return mod;
}

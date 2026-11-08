"use client";

import { useEffect } from "react";

/** Cinema mode for the guest seat pages: see cinema-init.ts. */
const DIM = "#08080c";

export function useCinemaMode(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const html = document.documentElement;
    html.classList.add("cinema", "dark");
    // The theme provider may re-apply the saved light theme after mount: keep it dark.
    const keepDark = new MutationObserver(() => {
      if (!html.classList.contains("dark")) html.classList.add("dark");
    });
    keepDark.observe(html, { attributes: true, attributeFilter: ["class"] });
    const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const before = metas.map((m) => m.content);
    metas.forEach((m) => (m.content = DIM));
    return () => {
      keepDark.disconnect();
      html.classList.remove("cinema");
      metas.forEach((m, i) => (m.content = before[i]));
      // Back to the saved appearance.
      try {
        const t = localStorage.getItem("canavo.theme");
        const dark = t === "dark" || ((!t || t === "system") && window.matchMedia("(prefers-color-scheme: dark)").matches);
        html.classList.toggle("dark", dark);
      } catch {
        /* ignore */
      }
    };
  }, [on]);
}

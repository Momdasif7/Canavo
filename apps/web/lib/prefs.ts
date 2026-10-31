/** Per-device preferences kept in localStorage. */
import type { PaperWidth } from "@canavo/shared";

const PAPER_KEY = "canavo.paperWidth";

export function getPaperWidth(): PaperWidth {
  try {
    return localStorage.getItem(PAPER_KEY) === "80" ? 80 : 58;
  } catch {
    return 58;
  }
}

export function setPaperWidth(w: PaperWidth) {
  try {
    localStorage.setItem(PAPER_KEY, String(w));
  } catch {
    /* ignore */
  }
}

const KOT_PAPER_KEY = "canavo.kotPaperWidth";

/** Kitchen ticket (KOT) printer roll width; falls back to the receipt width when never set. */
export function getKotPaperWidth(): PaperWidth {
  try {
    const v = localStorage.getItem(KOT_PAPER_KEY);
    if (v === "80") return 80;
    if (v === "58") return 58;
    return getPaperWidth();
  } catch {
    return 58;
  }
}

export function setKotPaperWidth(w: PaperWidth) {
  try {
    localStorage.setItem(KOT_PAPER_KEY, String(w));
  } catch {
    /* ignore */
  }
}

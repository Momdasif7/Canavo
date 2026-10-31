import type { PaperWidth } from "@canavo/shared";

/**
 * Print a plain-text thermal receipt with window.print(). The text is placed in
 * a .print-receipt element (see globals.css print rules) and the @page size is
 * set to the roll width so the browser's print dialog defaults correctly.
 */
export function printReceiptText(text: string, paper: PaperWidth, kind: "receipt" | "kot" = "receipt") {
  document.querySelectorAll(".print-receipt, style[data-print-page]").forEach((n) => n.remove());
  const el = document.createElement("pre");
  el.className = "print-receipt";
  el.dataset.paper = String(paper);
  // KOT text is always 32 columns; on an 80 mm roll it is printed larger to fill the width (globals.css).
  el.dataset.kind = kind;
  el.textContent = text;
  const style = document.createElement("style");
  style.dataset.printPage = "1";
  style.textContent = `@page { size: ${paper}mm auto; margin: 0 4mm; }`;
  document.head.appendChild(style);
  document.body.appendChild(el);
  const cleanup = () => {
    el.remove();
    style.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

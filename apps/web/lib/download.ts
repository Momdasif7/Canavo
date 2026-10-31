import { api } from "./api";

/** Download an authenticated API file (e.g. `?format=xlsx` reports) and save it. */
export async function downloadApiFile(path: string, query: Record<string, string | number | undefined> = {}, fallbackName = "download") {
  const { blob, filename } = await api.blob(path, { query }, fallbackName);
  saveBlob(blob, filename);
}

/** Save a Blob as a file via a temporary object URL. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Open a tab synchronously (inside the click handler, so popup blockers allow
 * it) and navigate it once an async result is ready.
 */
export function openPendingTab(): { go: (url: string) => boolean; cancel: () => void } {
  const win = window.open("", "_blank");
  return {
    go: (url) => {
      if (win && !win.closed) {
        win.location.href = url;
        return true;
      }
      return window.open(url, "_blank") !== null;
    },
    cancel: () => win?.close(),
  };
}

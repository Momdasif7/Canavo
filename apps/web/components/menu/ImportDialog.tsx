"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import { ArrowCounterClockwise, DownloadSimple, FileXls, UploadSimple } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { Alert } from "@/components/ui/States";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";

type RowAction = "create" | "update" | "error";

interface ImportRow {
  row: number;
  category: string;
  subcategory: string | null;
  name: string;
  action: RowAction;
  /** Paise */
  price: number | null;
  sizes: { name: string; price: number }[];
  gstRate: number | null;
  errors: string[];
  warnings: string[];
}

interface ImportResult {
  applied: boolean;
  summary: { total: number; create: number; update: number; error: number };
  rows: ImportRow[];
}

const MAX_BYTES = 5 * 1024 * 1024;
const ACTION_BADGE: Record<RowAction, { tone: "success" | "info" | "danger"; label: string }> = {
  create: { tone: "success", label: "New" },
  update: { tone: "info", label: "Update" },
  error: { tone: "danger", label: "Error" },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Bulk upload: download the Excel template, upload it for a dry-run preview
 * (nothing saved), then apply. Rows matching an existing category + item name
 * update that item, so the same sheet works for bulk price changes.
 */
export function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const close = () => {
    if (applying) return;
    reset();
    onClose();
  };

  const template = async () => {
    setDownloading(true);
    try {
      const { blob, filename } = await api.blob("/menu/import/template", {}, "canavo-menu-template.xlsx");
      saveBlob(blob, filename || "canavo-menu-template.xlsx");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDownloading(false);
    }
  };

  const send = (f: File, apply: boolean) => {
    const form = new FormData();
    form.append("file", f);
    return api.post<ImportResult>("/menu/import", form, { query: apply ? { apply: 1 } : undefined });
  };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setPreview(null);
    if (!/\.(xlsx|csv)$/i.test(f.name)) return setError("Choose the filled template (.xlsx) or a .csv file");
    if (f.size > MAX_BYTES) return setError("The file must be 5 MB or smaller");
    setFile(f);
    setChecking(true);
    try {
      setPreview(await send(f, false));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const valid = preview ? preview.summary.create + preview.summary.update : 0;

  const apply = async () => {
    if (!file || !valid) return;
    setApplying(true);
    setError(null);
    try {
      const res = await send(file, true);
      const { create, update, error: skipped } = res.summary;
      const parts = [create && `${create} added`, update && `${update} updated`].filter(Boolean).join(", ");
      toast(`Menu imported: ${parts || "no changes"}${skipped ? ` · ${plural(skipped, "row")} skipped` : ""}`, "success");
      onImported();
      reset();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      size="xl"
      title="Bulk upload menu"
      description="Add or update many items at once from an Excel sheet."
      footer={
        <>
          {preview && (
            <Button variant="ghost" className="mr-auto" icon={<ArrowCounterClockwise size={18} />} onClick={reset} disabled={applying}>
              Choose another file
            </Button>
          )}
          <Button variant="ghost" onClick={close} disabled={applying}>
            Cancel
          </Button>
          {preview && (
            <Button onClick={apply} loading={applying} disabled={!valid || checking}>
              {valid ? `Import ${plural(valid, "item")}` : "Nothing to import"}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert>{error}</Alert>}

        {!preview && (
          <>
            <section className="rounded-xl border border-line bg-surface-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold">
                    <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-primary-fg">1</span>
                    Download the template
                  </h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
                    <li>Fill one row per item on the “Menu” sheet. Columns marked * are required; “How to fill” explains each column.</li>
                    <li>
                      A row with the same <strong className="text-fg">category + item name</strong> as an existing item updates it — so you can also use this
                      for bulk price changes.
                    </li>
                    <li>Sizes go in one cell, e.g. “Regular=15; Large=25”. Missing categories are created.</li>
                    <li>Ingredients (e.g. “Potato=0.08; Pav=1”) deduct stock on every sale — the stock items must already exist in Inventory.</li>
                  </ul>
                </div>
                <Button variant="outline" icon={<DownloadSimple size={18} />} onClick={template} loading={downloading}>
                  Download template
                </Button>
              </div>
            </section>

            <section>
              <h3 className="mb-2 font-bold">
                <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-primary-fg">2</span>
                Upload the filled sheet
              </h3>
              <label
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDrag(false);
                  if (!checking) void choose(e.dataTransfer.files[0]);
                }}
                className={clsx(
                  "flex min-h-[140px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors",
                  drag ? "border-primary bg-primary-50 dark:bg-primary/10" : "border-line hover:border-primary",
                  checking && "pointer-events-none opacity-70",
                )}
              >
                {checking ? <Spinner className="h-8 w-8 text-primary" /> : <FileXls size={40} className="text-primary" />}
                <span className="font-semibold">{checking ? `Checking ${file?.name ?? "file"}…` : "Choose or drop a file"}</span>
                <span className="text-xs text-muted">.xlsx or .csv · up to 5 MB · nothing is saved until you confirm</span>
                {!checking && (
                  <span className="mt-1 inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-1.5 text-sm font-semibold">
                    <UploadSimple size={16} /> Browse
                  </span>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                  className="sr-only"
                  disabled={checking}
                  onChange={(e) => void choose(e.target.files?.[0])}
                />
              </label>
            </section>
          </>
        )}

        {preview && <Preview file={file} result={preview} />}
      </div>
    </Dialog>
  );
}

function Preview({ file, result }: { file: File | null; result: ImportResult }) {
  const { summary, rows } = result;
  const warnings = rows.filter((r) => r.warnings.length).length;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-1 font-bold">
          <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs text-primary-fg">3</span>
          Check and import
        </h3>
        {file && <span className="truncate text-sm text-muted">{file.name}</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Badge>{plural(summary.total, "row")}</Badge>
        <Badge tone="success">{summary.create} new</Badge>
        <Badge tone="info">{summary.update} updates</Badge>
        {summary.error > 0 && <Badge tone="danger">{plural(summary.error, "error")}</Badge>}
        {warnings > 0 && <Badge tone="warning">{plural(warnings, "warning")}</Badge>}
      </div>
      {summary.error > 0 && (
        <Alert tone="warning">
          {plural(summary.error, "row")} with errors will be skipped. Fix them in the sheet and upload again, or import the valid rows now.
        </Alert>
      )}
      <div className="max-h-[50vh] overflow-y-auto rounded-xl border border-line">
        <Table>
          <THead>
            <tr>
              <Th className="w-14">Row</Th>
              <Th>Item</Th>
              <Th>Category</Th>
              <Th className="text-right">Price / sizes</Th>
              <Th className="text-right">GST</Th>
              <Th>Action</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.row} className={clsx(r.action === "error" && "bg-red-50/60 dark:bg-red-500/5")}>
                <Td className="tabular align-top text-muted">{r.row}</Td>
                <Td className="align-top">
                  <p className="font-semibold">{r.name || <span className="text-muted">—</span>}</p>
                  {r.errors.map((e, i) => (
                    <p key={`e${i}`} className="text-xs font-medium text-red-600 dark:text-red-400">
                      {e}
                    </p>
                  ))}
                  {r.warnings.map((w, i) => (
                    <p key={`w${i}`} className="text-xs font-medium text-amber-700 dark:text-amber-300">
                      {w}
                    </p>
                  ))}
                </Td>
                <Td className="align-top text-muted">
                  {r.category || "—"}
                  {r.subcategory && ` › ${r.subcategory}`}
                </Td>
                <Td className="tabular align-top text-right">
                  {r.sizes.length > 0 ? (
                    <span className="text-xs">{r.sizes.map((s) => `${s.name} ${formatINR(s.price)}`).join(" · ")}</span>
                  ) : r.price != null ? (
                    <span className="font-semibold">{formatINR(r.price)}</span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </Td>
                <Td className="tabular align-top text-right">{r.gstRate != null ? `${r.gstRate}%` : <span className="text-muted">—</span>}</Td>
                <Td className="align-top">
                  <Badge tone={ACTION_BADGE[r.action].tone}>{ACTION_BADGE[r.action].label}</Badge>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </div>
    </section>
  );
}

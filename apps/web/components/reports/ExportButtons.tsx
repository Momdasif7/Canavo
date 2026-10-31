"use client";

import { useEffect, useRef, useState } from "react";
import { CaretDown, DownloadSimple, FileXls, FilePdf, FileCode } from "@phosphor-icons/react";
import { errorMessage } from "@/lib/api";
import { downloadApiFile } from "@/lib/download";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";

export type ExportFormat = "xlsx" | "pdf" | "json";
type Query = Record<string, string | number | undefined>;

export interface ExportSpec {
  /** API path, e.g. /reports/sales */
  path: string;
  /** Label for multi-report menus, e.g. "Items" */
  label?: string;
  query?: Query;
  formats?: ExportFormat[];
  /** Fallback filename stem (server usually sends one) */
  filename?: string;
}

const FORMAT_META: Record<ExportFormat, { label: string; icon: React.ReactNode; ext: string }> = {
  xlsx: { label: "Excel", icon: <FileXls size={20} />, ext: "xlsx" },
  pdf: { label: "PDF", icon: <FilePdf size={20} />, ext: "pdf" },
  json: { label: "JSON", icon: <FileCode size={20} />, ext: "json" },
};

function useExporter() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (spec: ExportSpec, format: ExportFormat) => {
    const id = `${spec.path}:${format}`;
    if (busy) return;
    setBusy(id);
    try {
      await downloadApiFile(spec.path, { ...spec.query, format }, `${spec.filename ?? spec.path.split("/").pop()}.${FORMAT_META[format].ext}`);
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, "error");
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

/**
 * Excel / PDF download buttons. One spec renders inline buttons; several
 * specs (e.g. items + categories) render a compact dropdown menu.
 */
export function ExportButtons({ specs, disabled }: { specs: ExportSpec[]; disabled?: boolean }) {
  const { busy, run } = useExporter();
  if (specs.length === 1) {
    const spec = specs[0];
    return (
      <div className="flex gap-2">
        {(spec.formats ?? ["xlsx", "pdf"]).map((f) => (
          <Button
            key={f}
            variant="outline"
            size="sm"
            disabled={disabled}
            loading={busy === `${spec.path}:${f}`}
            icon={FORMAT_META[f].icon}
            onClick={() => void run(spec, f)}
          >
            {FORMAT_META[f].label}
          </Button>
        ))}
      </div>
    );
  }
  return <ExportMenu specs={specs} disabled={disabled} busy={busy} run={run} />;
}

function ExportMenu({
  specs,
  disabled,
  busy,
  run,
}: {
  specs: ExportSpec[];
  disabled?: boolean;
  busy: string | null;
  run: (s: ExportSpec, f: ExportFormat) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        loading={busy !== null}
        icon={<DownloadSimple size={20} />}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        Export <CaretDown size={14} />
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 z-30 mt-2 w-56 animate-fade-in overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-xl">
          {specs.map((spec) =>
            (spec.formats ?? ["xlsx", "pdf"]).map((f) => (
              <button
                key={`${spec.path}:${f}`}
                type="button"
                role="menuitem"
                className="flex min-h-[44px] w-full items-center gap-2 px-3 text-left text-sm font-semibold hover:bg-surface-2"
                onClick={() => {
                  setOpen(false);
                  void run(spec, f);
                }}
              >
                {busy === `${spec.path}:${f}` ? <Spinner className="h-5 w-5" /> : FORMAT_META[f].icon}
                {spec.label ?? spec.path} — {FORMAT_META[f].label}
              </button>
            )),
          )}
        </div>
      )}
    </div>
  );
}

/** Single download button for any authenticated file (backups, GSTN JSON, data export). */
export function DownloadButton({
  path,
  query,
  filename,
  children,
  variant = "outline",
  icon,
  size = "sm",
}: {
  path: string;
  query?: Query;
  filename: string;
  children: React.ReactNode;
  variant?: "outline" | "primary" | "secondary" | "ghost";
  icon?: React.ReactNode;
  size?: "sm" | "md";
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      size={size}
      loading={busy}
      icon={icon ?? <DownloadSimple size={20} />}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadApiFile(path, query, filename);
        } catch (e) {
          toast(`Download failed: ${errorMessage(e)}`, "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </Button>
  );
}

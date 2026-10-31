"use client";

import { useId, useRef, useState } from "react";
import clsx from "clsx";
import { ImageSquare, Trash, UploadSimple } from "@phosphor-icons/react";
import { errorMessage, request } from "@/lib/api";
import { mediaUrl } from "@/lib/media";
import { Button } from "./Button";
import { Spinner } from "./Spinner";

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ["image/jpeg", "image/png", "image/webp"];

/** Upload an image to POST /uploads/image (multipart field "file") and return its public URL. */
export async function uploadImage(file: File): Promise<string> {
  if (!ACCEPT.includes(file.type)) throw new Error("Only JPEG, PNG or WebP images are allowed");
  if (file.size > MAX_BYTES) throw new Error("Image must be 5 MB or smaller");
  const form = new FormData();
  form.append("file", file);
  // No content-type: the browser sets the multipart boundary.
  const res = await request("/uploads/image", { method: "POST", rawBody: form, outletId: null });
  const data = (await res.json()) as { url: string };
  return data.url;
}

/**
 * Image picker with preview: upload a file (click or drop) or paste a URL.
 * `value` is the stored URL ("" when none).
 */
export function ImageUpload({
  label,
  value,
  onChange,
  hint,
  disabled,
  shape = "square",
}: {
  label: string;
  value: string;
  onChange: (url: string) => void;
  hint?: string;
  disabled?: boolean;
  shape?: "square" | "wide";
}) {
  const id = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [broken, setBroken] = useState(false);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const url = await uploadImage(file);
      setBroken(false);
      onChange(url);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-url`} className="text-sm font-semibold text-fg">
        {label}
      </label>
      <div className="flex items-start gap-3">
        <div
          onDragOver={(e) => {
            if (disabled) return;
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!disabled) void handle(e.dataTransfer.files[0]);
          }}
          className={clsx(
            "relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-dashed bg-surface-2",
            shape === "wide" ? "h-20 w-32" : "h-20 w-20",
            drag ? "border-primary bg-primary-50 dark:bg-primary/10" : "border-line",
          )}
        >
          {value && !broken ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary upload/CDN hosts
            <img src={mediaUrl(value)} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} />
          ) : (
            <ImageSquare size={28} className="text-muted" />
          )}
          {busy && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface/70">
              <Spinner className="h-6 w-6 text-primary" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" icon={<UploadSimple size={18} />} disabled={disabled || busy} onClick={() => fileRef.current?.click()}>
              {value ? "Replace" : "Upload"}
            </Button>
            {value && (
              <Button variant="ghost" size="sm" icon={<Trash size={18} />} disabled={disabled || busy} onClick={() => onChange("")}>
                Remove
              </Button>
            )}
          </div>
          <input
            id={`${id}-url`}
            type="url"
            placeholder="or paste an image URL"
            value={value}
            disabled={disabled}
            onChange={(e) => {
              setBroken(false);
              onChange(e.target.value);
            }}
            className="min-h-[40px] w-full rounded-xl border border-line bg-surface px-3 text-sm text-fg placeholder:text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
          />
        </div>
      </div>
      <input ref={fileRef} type="file" accept={ACCEPT.join(",")} className="hidden" onChange={(e) => void handle(e.target.files?.[0])} />
      {error ? (
        <p className="text-sm font-medium text-red-600">{error}</p>
      ) : broken && value ? (
        <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Couldn&apos;t load a preview for this URL.</p>
      ) : (
        <p className="text-xs text-muted">{hint ?? "JPEG, PNG or WebP up to 5 MB. Drop a file on the preview to upload."}</p>
      )}
    </div>
  );
}

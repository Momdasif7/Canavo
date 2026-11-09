"use client";

import { forwardRef, useEffect, useRef, useState } from "react";
import { Barcode, Camera } from "@phosphor-icons/react";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

/**
 * Scan box for USB (keyboard-wedge) barcode scanners: they type the code
 * quickly and press Enter. Also works for typing a code/SKU manually.
 */
export const ScanInput = forwardRef<
  HTMLInputElement,
  { onScan: (code: string) => void | Promise<void>; placeholder?: string; label?: string; busy?: boolean; className?: string }
>(function ScanInput({ onScan, placeholder = "Scan barcode / SKU + Enter", label = "Scan barcode or SKU", busy, className }, ref) {
  const [code, setCode] = useState("");
  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        const c = code.trim();
        if (!c || busy) return;
        setCode("");
        void onScan(c);
      }}
    >
      <Input
        ref={ref}
        aria-label={label}
        placeholder={placeholder}
        value={code}
        maxLength={64}
        autoComplete="off"
        onChange={(e) => setCode(e.target.value)}
        prefix={<Barcode size={18} />}
        aria-busy={busy}
      />
    </form>
  );
});

// Minimal typings for the Shape Detection API (not yet in lib.dom).
interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

const getDetector = (): BarcodeDetectorCtor | undefined =>
  typeof window !== "undefined" && "BarcodeDetector" in window ? (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector : undefined;

/** True once mounted in a browser that supports BarcodeDetector + camera access. */
export function useCameraScanSupported(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => setOk(!!getDetector() && !!navigator.mediaDevices?.getUserMedia), []);
  return ok;
}

/** Button that opens the webcam scanner; hidden when unsupported. */
export function CameraScanButton({ onScan, label = "Scan with camera" }: { onScan: (code: string) => void; label?: string }) {
  const supported = useCameraScanSupported();
  const [open, setOpen] = useState(false);
  if (!supported) return null;
  return (
    <>
      <IconButton label={label} onClick={() => setOpen(true)} className="border border-line">
        <Camera size={22} />
      </IconButton>
      <CameraScanDialog
        open={open}
        onClose={() => setOpen(false)}
        onDetected={(c) => {
          setOpen(false);
          onScan(c);
        }}
      />
    </>
  );
}

export function CameraScanDialog({ open, onClose, onDetected }: { open: boolean; onClose: () => void; onDetected: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const detectedRef = useRef(onDetected);
  detectedRef.current = onDetected;

  useEffect(() => {
    if (!open) return;
    setError(null);
    const Ctor = getDetector();
    if (!Ctor) {
      setError("Camera scanning isn't supported in this browser");
      return;
    }
    let stream: MediaStream | null = null;
    let timer: number | undefined;
    let stopped = false;
    const detector = new Ctor({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code"] });

    const loop = async () => {
      if (stopped) return;
      const v = videoRef.current;
      if (v && v.readyState >= 2) {
        try {
          const found = await detector.detect(v);
          const code = found[0]?.rawValue?.trim();
          if (code && !stopped) {
            stopped = true;
            detectedRef.current(code);
            return;
          }
        } catch {
          /* frame not ready — keep trying */
        }
      }
      timer = window.setTimeout(loop, 250);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => undefined);
        }
        void loop();
      } catch (e) {
        setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Camera permission was denied" : "Could not start the camera");
      }
    })();

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Scan barcode"
      description="Hold the barcode steady in front of the camera"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error ? (
        <Alert>{error}</Alert>
      ) : (
        <div className="relative overflow-hidden rounded-xl bg-black">
          <video ref={videoRef} muted playsInline className="aspect-video w-full object-cover" />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-primary/80 shadow-[0_0_12px_rgb(var(--primary)/0.8)]" />
        </div>
      )}
    </Dialog>
  );
}

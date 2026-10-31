"use client";

import { useEffect, useState } from "react";
import { DownloadSimple, Printer, WhatsappLogo } from "@phosphor-icons/react";
import { indianPhone, type PaperWidth } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { openPendingTab } from "@/lib/download";
import { getPaperWidth, setPaperWidth } from "@/lib/prefs";
import { printReceiptText } from "@/lib/print";
import type { ShareResult } from "@/lib/types";
import { handleWhatsAppResult } from "@/lib/whatsapp";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Spinner } from "@/components/ui/Spinner";

/** Thermal-style preview of /orders/:id/receipt?format=text with print, PDF and WhatsApp actions. */
export function ReceiptActions({
  orderId,
  customerPhone,
  showPreview = true,
  autoFocusPrint = false,
}: {
  orderId: string;
  customerPhone?: string | null;
  showPreview?: boolean;
  autoFocusPrint?: boolean;
}) {
  const toast = useToast();
  const [paper, setPaper] = useState<PaperWidth>(58);
  const [text, setText] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [phone, setPhone] = useState(customerPhone ?? "");
  const [shareBusy, setShareBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  useEffect(() => setPaper(getPaperWidth()), []);

  useEffect(() => {
    let cancelled = false;
    setLoadingText(true);
    api
      .text(`/orders/${orderId}/receipt`, { query: { format: "text", paper } })
      .then((t) => !cancelled && setText(t))
      .catch((e) => !cancelled && toast(errorMessage(e), "error"))
      .finally(() => !cancelled && setLoadingText(false));
    return () => {
      cancelled = true;
    };
  }, [orderId, paper, toast]);

  const changePaper = (p: PaperWidth) => {
    setPaper(p);
    setPaperWidth(p);
  };

  const print = () => {
    if (text) printReceiptText(text, paper);
  };

  const pdf = async () => {
    const tab = openPendingTab();
    setPdfBusy(true);
    try {
      const { blob } = await api.blob(`/orders/${orderId}/receipt.pdf`);
      const url = URL.createObjectURL(blob);
      tab.go(url);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab.cancel();
      toast(errorMessage(e), "error");
    } finally {
      setPdfBusy(false);
    }
  };

  const share = async () => {
    const parsed = indianPhone.safeParse(phone);
    if (!parsed.success) {
      setPhoneError(parsed.error.issues[0].message);
      return;
    }
    setPhoneError(null);
    const tab = openPendingTab();
    setShareBusy(true);
    try {
      const res = await api.post<ShareResult>(`/orders/${orderId}/share/whatsapp`, { phone: parsed.data });
      handleWhatsAppResult(res, tab, toast, { sent: "Sent on WhatsApp" });
    } catch (e) {
      tab.cancel();
      toast(errorMessage(e), "error");
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          value={String(paper) as "58" | "80"}
          onChange={(v) => changePaper(v === "80" ? 80 : 58)}
          options={[
            { value: "58", label: "58 mm" },
            { value: "80", label: "80 mm" },
          ]}
        />
        <Button icon={<Printer size={20} />} onClick={print} disabled={!text} autoFocus={autoFocusPrint} data-print-button>
          Print <kbd className="ml-1 hidden rounded bg-white/20 px-1.5 text-xs lg:inline">F10</kbd>
        </Button>
        <Button variant="outline" icon={<DownloadSimple size={20} />} onClick={pdf} loading={pdfBusy}>
          PDF
        </Button>
      </div>

      {showPreview && (
        <div className="flex justify-center rounded-xl bg-surface-2 p-3">
          {loadingText ? (
            <Spinner className="my-10 h-6 w-6 text-muted" />
          ) : (
            <pre
              className="max-h-[340px] overflow-auto bg-white px-3 py-3 font-mono text-[11px] leading-snug text-black shadow-sm"
              style={{ width: paper === 58 ? "34ch" : "50ch" }}
              aria-label="Receipt preview"
            >
              {text}
            </pre>
          )}
        </div>
      )}

      <div className="flex items-start gap-2">
        <Input
          wrapperClassName="flex-1"
          inputMode="numeric"
          maxLength={10}
          placeholder="Customer WhatsApp number"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
          error={phoneError}
          prefix={<span className="text-sm font-semibold">+91</span>}
          className="pl-12"
        />
        <Button variant="secondary" icon={<WhatsappLogo size={22} weight="fill" />} onClick={share} loading={shareBusy}>
          Share
        </Button>
      </div>
    </div>
  );
}

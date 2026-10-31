"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ArrowsClockwise, CheckCircle, Flask } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { PaymentStatusResponse, UpiQr } from "@/lib/types";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/States";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Dynamic UPI QR for an order's balance. Completion arrives via the
 * `order:paid` socket event, with 3-second polling as a fallback.
 */
export function UpiQrPanel({ orderId, onPaid }: { orderId: string; onPaid: () => void }) {
  const [qr, setQr] = useState<UpiQr | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"simulate" | "confirm" | null>(null);
  const doneRef = useRef(false);
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onPaidRef.current();
  }, []);

  const generate = useCallback(async () => {
    setQr(null);
    setError(null);
    try {
      setQr(await api.post<UpiQr>(`/orders/${orderId}/upi-qr`, {}));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [orderId]);

  useEffect(() => {
    void generate();
  }, [generate]);

  useSocketEvent<{ id: string }>("order:paid", (p) => {
    if (p?.id === orderId) finish();
  });

  useEffect(() => {
    if (!qr) return;
    const id = window.setInterval(async () => {
      try {
        const s = await api.get<PaymentStatusResponse>(`/orders/${orderId}/payment-status`);
        if (s.status === "PAID") finish();
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [qr, orderId, finish]);

  const act = async (kind: "simulate" | "confirm") => {
    if (!qr) return;
    setBusy(kind);
    setError(null);
    try {
      const path = kind === "simulate" ? "dev-simulate" : "confirm";
      const res = await api.post<{ paid: boolean }>(`/orders/${orderId}/payments/${qr.paymentId}/${path}`, {});
      if (res.paid) finish();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4 py-2">
      {error && (
        <div className="w-full">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="flex h-[248px] w-[248px] items-center justify-center rounded-2xl border border-line bg-white p-3">
        {qr ? (
          qr.imageUrl ? (
            // Hosted Razorpay QR image (external URL, so a plain img is appropriate)
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr.imageUrl} alt="UPI QR code" className="h-full w-full object-contain" />
          ) : (
            <QRCodeSVG value={qr.qrPayload} size={220} level="M" marginSize={0} title="UPI QR code" />
          )
        ) : error ? null : (
          <Spinner className="h-8 w-8 text-muted" />
        )}
      </div>
      {qr && (
        <div className="text-center">
          <p className="tabular text-2xl font-extrabold">{formatINR(qr.amount)}</p>
          <p className="flex items-center justify-center gap-2 text-sm text-muted">
            <Spinner className="h-4 w-4" /> Waiting for customer to pay…
          </p>
        </div>
      )}
      <div className="flex w-full flex-wrap justify-center gap-2">
        {qr?.mock && (
          <Button variant="outline" icon={<Flask size={20} />} loading={busy === "simulate"} onClick={() => act("simulate")}>
            Simulate payment (dev)
          </Button>
        )}
        <Button variant="secondary" icon={<CheckCircle size={20} />} loading={busy === "confirm"} disabled={!qr} onClick={() => act("confirm")}>
          Confirm manually
        </Button>
        <Button variant="ghost" icon={<ArrowsClockwise size={20} />} onClick={generate}>
          New QR
        </Button>
      </div>
      {qr?.mock && <p className="text-center text-xs text-muted">Payment gateway not configured — QR is a plain UPI intent for the outlet VPA.</p>}
    </div>
  );
}

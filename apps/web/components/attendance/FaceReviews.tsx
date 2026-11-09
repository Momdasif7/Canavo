"use client";

import { useState } from "react";
import { Check, X } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { mediaUrl } from "@/lib/media";
import type { FaceReview } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

const STATE: Record<FaceReview["faceCheck"], { label: string; tone: "warning" | "danger" | "success" | "info" }> = {
  PENDING_REVIEW: { label: "To review", tone: "info" },
  MISMATCH: { label: "Doubtful match", tone: "warning" },
  MATCHED: { label: "Matched", tone: "success" },
  APPROVED: { label: "Approved", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
};

function Photo({ url, label }: { url: string | null; label: string }) {
  return (
    <figure className="flex flex-1 flex-col items-center gap-1">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaUrl(url)} alt={label} className="aspect-square w-full max-w-[180px] rounded-lg border border-line object-cover" />
      ) : (
        <div className="flex aspect-square w-full max-w-[180px] items-center justify-center rounded-lg border border-dashed border-line text-xs text-muted">
          {label === "Reference" ? "Withdrawn" : "Deleted (90 days)"}
        </div>
      )}
      <figcaption className="text-xs text-muted">{label}</figcaption>
    </figure>
  );
}

/**
 * Gap 7: manager review queue for clock-in face checks (CLOCK_IN_FACE_MATCH). The reference photo and the clock-in
 * selfie side by side, with the liveness prompt the app showed. A rejection flags the record; it never deletes it.
 */
export function FaceReviews() {
  const toast = useToast();
  const [status, setStatus] = useState<"open" | "all">("open");
  const q = useApiQuery(`face-reviews:${status}`, () => api.get<FaceReview[]>(`/attendance/face/reviews?status=${status}`));
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (id: string, decision: "APPROVED" | "REJECTED") => {
    setBusy(id);
    try {
      await api.post(`/attendance/${id}/face-review`, { decision });
      toast(decision === "APPROVED" ? "Clock-in approved" : "Clock-in rejected and flagged", "success");
      await q.reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Compare each clock-in selfie with the staff member&apos;s reference photo. Check the selfie follows the prompt.</p>
        <Segmented value={status} onChange={setStatus} options={[{ value: "open", label: "To review" }, { value: "all", label: "All" }]} />
      </div>
      {q.loading && !q.data ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !q.data?.length ? (
        <EmptyState title={status === "open" ? "Nothing to review" : "No face checks yet"} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">
          {q.data.map((r) => (
            <li key={r.id} className="space-y-3 rounded-xl border border-line p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{r.user.name}</p>
                  <p className="tabular text-xs text-muted">
                    {r.workDate} · {formatTime(r.clockInAt)}
                    {r.faceScore != null && ` · on-device score ${Math.round(r.faceScore * 100)}%`}
                  </p>
                </div>
                <Badge tone={STATE[r.faceCheck].tone}>{STATE[r.faceCheck].label}</Badge>
              </div>
              <div className="flex gap-3">
                <Photo url={r.refPhotoUrl} label="Reference" />
                <Photo url={r.selfieUrl} label="Clock-in selfie" />
              </div>
              <p className="text-xs text-muted">Prompt shown: {r.livenessPrompt ?? "none"}</p>
              {(r.faceCheck === "PENDING_REVIEW" || r.faceCheck === "MISMATCH") && (
                <div className="flex gap-2">
                  <Button size="sm" icon={<Check size={16} />} loading={busy === r.id} onClick={() => decide(r.id, "APPROVED")}>
                    Same person
                  </Button>
                  <Button size="sm" variant="danger" icon={<X size={16} />} disabled={busy === r.id} onClick={() => decide(r.id, "REJECTED")}>
                    Not them
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

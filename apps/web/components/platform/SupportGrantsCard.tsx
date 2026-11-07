"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye } from "@phosphor-icons/react";
import { errorMessage } from "@/lib/api";
import { platformApi } from "@/lib/platform";
import { formatDateTime } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Alert, LoadingState } from "@/components/ui/States";

interface SupportGrantRow {
  id: string;
  business: { id: string; name: string; status: string };
  reason: string | null;
  expiresAt: string;
  createdAt: string;
  grantedBy: string | null;
}

/**
 * Hotels whose owners currently allow support access. Opening one shows the hotel read-only;
 * the owner sees every screen opened. Needs your own two-step login.
 */
export function SupportGrantsCard() {
  const router = useRouter();
  const { me, enterSupport } = useSession();
  const grants = useApiQuery("platform-support-grants", () => platformApi.get<SupportGrantRow[]>("/platform/support-grants"));
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (g: SupportGrantRow) => {
    setOpening(g.id);
    setError(null);
    try {
      await enterSupport(g.business.id);
      router.push("/dashboard");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <Card className="mb-5">
      <CardHeader title="Support access" subtitle="Hotels whose owner has allowed the CANAVO team to look in (read-only, time-limited). The owner sees every screen you open." />
      <div className="divide-y divide-line">
        {error && (
          <div className="p-4">
            <Alert>{error}</Alert>
          </div>
        )}
        {!me?.twoFactorEnabled && (
          <div className="p-4">
            <Alert tone="warning">Turn on two-step login under Account → Security to use support access.</Alert>
          </div>
        )}
        {grants.loading && !grants.data ? (
          <LoadingState />
        ) : !grants.data?.length ? (
          <p className="px-5 py-4 text-sm text-muted">No hotel has granted support access right now. Owners grant it under Settings → Support access.</p>
        ) : (
          grants.data.map((g) => (
            <div key={g.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{g.business.name}</p>
                <p className="text-xs text-muted">
                  Allowed by {g.grantedBy ?? "the owner"} until {formatDateTime(g.expiresAt)}
                  {g.reason && ` · “${g.reason}”`}
                </p>
              </div>
              <Button size="sm" icon={<Eye size={18} />} loading={opening === g.id} disabled={!me?.twoFactorEnabled} onClick={() => void open(g)}>
                Open support view
              </Button>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

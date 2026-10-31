"use client";

import { useSession } from "@/components/providers/SessionProvider";
import { isDeliveryPartner } from "@/components/layout/nav";
import { DutyBar, DutyProvider } from "@/components/delivery/partner/duty";
import { RunStatusProvider } from "@/components/delivery/partner/run";

/** Delivery partners get the duty bar (clock in / out) on top of every portal page. */
export default function DeliveryLayout({ children }: { children: React.ReactNode }) {
  const { me, outletId } = useSession();
  if (!me || !isDeliveryPartner({ me, outletId })) return <>{children}</>;
  return (
    <DutyProvider>
      {/* GPS while on duty: tells the outlet when the partner is back after a run */}
      <RunStatusProvider>
        <div className="mx-auto w-full max-w-[1440px] px-4 pt-4 md:px-6">
          <DutyBar />
        </div>
        {children}
      </RunStatusProvider>
    </DutyProvider>
  );
}

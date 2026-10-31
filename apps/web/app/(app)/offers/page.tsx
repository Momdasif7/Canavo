"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "@/components/providers/SessionProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { OffersTab } from "@/components/crm/OffersTab";
import { CouponsTab } from "@/components/crm/CouponsTab";
import { CouponReportTab } from "@/components/crm/CouponReportTab";

type Tab = "offers" | "coupons" | "usage";
const TABS: Tab[] = ["offers", "coupons", "usage"];

export default function OffersPage() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={<LoadingState />}>
      <OffersPageInner />
    </Suspense>
  );
}

function OffersPageInner() {
  const { can } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const fromUrl = params.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(fromUrl && TABS.includes(fromUrl) ? fromUrl : "offers");

  useEffect(() => {
    if (fromUrl && TABS.includes(fromUrl)) setTab(fromUrl);
  }, [fromUrl]);

  const change = (t: Tab) => {
    setTab(t);
    router.replace(t === "offers" ? "/offers" : `/offers?tab=${t}`, { scroll: false });
  };

  if (!can("offer:manage"))
    return (
      <PageContainer>
        <ErrorState message="You don't have permission to manage offers and coupons." />
      </PageContainer>
    );

  return (
    <PageContainer>
      <PageHeader
        title="Offers & Coupons"
        subtitle="Automatic offers apply at the POS on their own; coupons are entered by the cashier."
        actions={
          <Segmented
            value={tab}
            onChange={change}
            options={[
              { value: "offers", label: "Offers" },
              { value: "coupons", label: "Coupons" },
              { value: "usage", label: "Coupon usage" },
            ]}
          />
        }
      />
      {tab === "offers" && <OffersTab />}
      {tab === "coupons" && <CouponsTab />}
      {tab === "usage" && <CouponReportTab />}
    </PageContainer>
  );
}

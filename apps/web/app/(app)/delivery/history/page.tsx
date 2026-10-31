"use client";

import { PartnerHistory } from "@/components/delivery/partner/PartnerHistory";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";

export default function DeliveryHistoryPage() {
  return (
    <PageContainer>
      <PageHeader title="Delivery history" subtitle="Delivered and cancelled orders" />
      <PartnerHistory />
    </PageContainer>
  );
}

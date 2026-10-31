"use client";

import { PartnerDashboard } from "@/components/delivery/partner/PartnerDashboard";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";

export default function DeliveryDashboardPage() {
  return (
    <PageContainer>
      <PageHeader title="My dashboard" subtitle="Your deliveries and the money you collected" />
      <PartnerDashboard />
    </PageContainer>
  );
}

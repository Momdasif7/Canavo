"use client";

import { CashHandover } from "@/components/delivery/partner/CashHandover";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";

export default function DeliveryCashPage() {
  return (
    <PageContainer>
      <PageHeader title="Cash handover" subtitle="Cash you collected that goes to the outlet" />
      <CashHandover />
    </PageContainer>
  );
}

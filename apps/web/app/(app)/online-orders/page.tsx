"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { OnlineOrdersBoard } from "@/components/channels/OnlineOrdersBoard";

/** Billing & orders → Online orders (module CHANNELS; channel:manage or order:create — the route guard checks the nav entry). */
export default function OnlineOrdersPage() {
  return (
    <PageContainer>
      <PageHeader title="Online orders" subtitle="Zomato, Swiggy and online-page orders arrive billed — pack them and hand them to the rider." />
      <OnlineOrdersBoard />
    </PageContainer>
  );
}

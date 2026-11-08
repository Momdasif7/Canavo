"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { IntegrationsPanel } from "@/components/settings/IntegrationsPanel";

/** Settings → Integrations: the store's own Razorpay, WhatsApp, email and SMS accounts (owner; managers see status). */
export default function IntegrationsPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="max-w-5xl">
        <IntegrationsPanel />
      </div>
    </PageContainer>
  );
}

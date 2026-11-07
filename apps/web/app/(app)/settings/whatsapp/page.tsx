"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { WhatsAppSettingsCard } from "@/components/settings/WhatsAppSettingsCard";

/** Settings → WhatsApp (settings:outlet; the route guard checks the nav entry). */
export default function WhatsAppSettingsPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="max-w-5xl">
        <WhatsAppSettingsCard />
      </div>
    </PageContainer>
  );
}

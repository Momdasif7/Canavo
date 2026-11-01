"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { OnlineOrderingSettings } from "@/components/storefront/OnlineOrderingSettings";

/** Settings → Online ordering (channel:manage; the route guard checks the nav entry). */
export default function OnlineOrderingSettingsPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="max-w-5xl">
        <OnlineOrderingSettings />
      </div>
    </PageContainer>
  );
}

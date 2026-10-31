"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { GstSettingsCard } from "@/components/settings/GstSettingsCard";
import { TaxRatesCard } from "@/components/settings/TaxRatesCard";

/** Settings → GST & Taxes (settings:billing; the route guard checks the nav entry). */
export default function TaxSettingsPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="space-y-5">
        <GstSettingsCard />
        <TaxRatesCard />
      </div>
    </PageContainer>
  );
}

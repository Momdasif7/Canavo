"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { SupportAccessCard } from "@/components/settings/SupportAccessCard";

/** Settings → Support access (owner only; the route guard checks the nav entry). */
export default function SupportAccessPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="max-w-4xl">
        <SupportAccessCard />
      </div>
    </PageContainer>
  );
}

"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { ChannelsSettings } from "@/components/settings/ChannelsSettings";

/** Settings → Channels (channel:manage, module CHANNELS; the route guard checks the nav entry). */
export default function ChannelsSettingsPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="max-w-6xl">
        <ChannelsSettings />
      </div>
    </PageContainer>
  );
}

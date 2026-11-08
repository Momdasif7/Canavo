"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { WhatsAppTemplates } from "@/components/settings/WhatsAppTemplates";

/** Settings → WhatsApp templates (settings:outlet reads; the owner edits). Provider and keys are under Integrations. */
export default function WhatsAppTemplatesPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="max-w-5xl">
        <WhatsAppTemplates />
      </div>
    </PageContainer>
  );
}

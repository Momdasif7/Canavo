"use client";

import Link from "next/link";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { DeviceAlertSettings } from "@/components/notifications/NotificationList";

/** Settings → Notifications: per-device alerts (sound, desktop). Business-wide channels live in Admin. */
export default function NotificationSettingsPage() {
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="max-w-2xl space-y-4">
        <DeviceAlertSettings />
        <p className="text-sm text-muted">
          See every notification on the{" "}
          <Link href="/notifications" className="font-semibold text-primary hover:underline">
            notifications page
          </Link>
          .
        </p>
      </div>
    </PageContainer>
  );
}

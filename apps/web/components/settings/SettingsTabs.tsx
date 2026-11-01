"use client";

import { BellRinging, GearSix, Lifebuoy, Percent, PlugsConnected, QrCode, Storefront, WhatsappLogo } from "@phosphor-icons/react";
import { useSession } from "@/components/providers/SessionProvider";
import { TabNav, type TabLink } from "@/components/reports/TabNav";

/** Sub-navigation of the Settings category: outlet profile, GST & taxes, WhatsApp, notifications, outlets. */
export function SettingsTabs() {
  const { can } = useSession();
  const tabs: TabLink[] = [];
  if (can("settings:view")) tabs.push({ href: "/settings", label: "Outlet & devices", icon: GearSix });
  if (can("settings:view") && can("settings:billing")) tabs.push({ href: "/settings/taxes", label: "GST & Taxes", icon: Percent });
  if (can("settings:view") && can("settings:outlet")) tabs.push({ href: "/settings/whatsapp", label: "WhatsApp", icon: WhatsappLogo });
  if (can("channel:manage")) tabs.push({ href: "/settings/online-ordering", label: "Online ordering", icon: QrCode });
  if (can("channel:manage")) tabs.push({ href: "/settings/channels", label: "Channels", icon: PlugsConnected });
  if (can("settings:view")) tabs.push({ href: "/settings/notifications", label: "Notifications", icon: BellRinging });
  if (can("outlet:manage")) tabs.push({ href: "/settings/support", label: "Support access", icon: Lifebuoy });
  if (can("outlet:manage")) tabs.push({ href: "/outlets", label: "Outlets", icon: Storefront });
  if (tabs.length < 2) return null;
  return <TabNav tabs={tabs} label="Settings sections" />;
}

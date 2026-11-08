"use client";

import { useState } from "react";
import Link from "next/link";
import { Globe, ShieldWarning, Storefront } from "@phosphor-icons/react";
import type { SettingKey } from "@canavo/shared";
import { api } from "@/lib/api";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import type { SettingsIndex } from "@/components/admin/types";
import { SettingCard, type SettingOf } from "@/components/admin/settings/SettingCard";
import {
  IpWhitelistEditor,
  LeadMinutesEditor,
  NotificationPrefsEditor,
  PrinterDefaultsEditor,
} from "@/components/admin/settings/editors";
import { Segmented } from "@/components/ui/Segmented";
import { Card, CardHeader } from "@/components/ui/Card";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

export default function SystemSettingsPage() {
  const { me, outletId, can } = useSession();
  const index = useApiQuery<SettingsIndex>("settings-index", () => api.get<SettingsIndex>("/admin/settings", { outletId: null }));
  const [scopeKind, setScopeKind] = useState<"GLOBAL" | "OUTLET">("OUTLET");
  // The platform admin manages platform-wide (GLOBAL) defaults only — never an outlet's.
  const platformAdmin = Boolean(me?.platformAdmin);
  const outletName = me?.outlets.find((o) => o.id === outletId)?.name ?? "This outlet";
  const scope = platformAdmin || scopeKind === "GLOBAL" ? "GLOBAL" : outletId ?? "GLOBAL";
  const isGlobal = scope === "GLOBAL";
  // For business users GLOBAL means "the whole business"; only outlet:manage (owners) may write it.
  const readOnly = isGlobal && !platformAdmin && !can("outlet:manage");
  const globalLabel = platformAdmin ? "Platform-wide" : me?.business ? "Business-wide" : "Global";

  const def = <K extends SettingKey>(k: K) => index.data?.defaults[k] as SettingOf<K> | undefined;
  const globalOnly = index.data?.globalOnly ?? ["security.ipWhitelist"];

  return (
    <>
      <PageHeader
        title="System settings"
        subtitle={
          platformAdmin
            ? "Platform-wide defaults for every business (each business can override them) and platform security. Changes are audited."
            : me?.business
              ? `Outlet values override ${me.business.name}'s business-wide ones. Changes are audited.`
              : "Outlet values override global ones. Changes are audited."
        }
        actions={
          !platformAdmin && (
            <Segmented
              value={scopeKind}
              onChange={setScopeKind}
              options={[
                {
                  value: "GLOBAL",
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <Globe size={18} /> {globalLabel}
                    </span>
                  ),
                },
                {
                  value: "OUTLET",
                  label: (
                    <span className="inline-flex max-w-[180px] items-center gap-1.5 truncate">
                      <Storefront size={18} /> {outletName}
                    </span>
                  ),
                },
              ]}
            />
          )
        }
      />
      {readOnly && (
        <div className="mb-5">
          <Alert tone="info">{globalLabel} settings are read-only for your role. Switch to {outletName} to change outlet-level values.</Alert>
        </div>
      )}
      {index.loading && !index.data ? (
        <LoadingState />
      ) : index.error ? (
        <ErrorState message={index.error} onRetry={index.reload} />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2" key={scope}>
          <div className="space-y-5 xl:col-span-2">
            <SettingCard
              settingKey="notifications.prefs"
              scope={scope}
              title="Notification channels"
              description="Which channels each event goes out on. Unticked “Custom” rows inherit from their group, then the default."
              readOnly={readOnly}
              defaults={def("notifications.prefs")}
              notice={
                !isGlobal && (
                  <Alert tone="warning">
                    The server currently routes notifications using the <b>{globalLabel}</b> preferences only; outlet-level values are stored for future use.
                  </Alert>
                )
              }
              render={(p) => <NotificationPrefsEditor {...p} />}
            />
          </div>
          <SettingCard
            settingKey="printer.defaults"
            scope={scope}
            title="Printer defaults"
            description="Defaults for POS terminals. Each device can still override its paper width."
            readOnly={readOnly}
            defaults={def("printer.defaults")}
            render={(p) => <PrinterDefaultsEditor {...p} />}
          />
          <div className="space-y-5">
            <SettingCard
              settingKey="service.preOrderLeadMinutes"
              scope={scope}
              title="Pre-order lead time"
              description="How far ahead customers must place pre-orders."
              readOnly={readOnly}
              defaults={def("service.preOrderLeadMinutes")}
              render={(p) => <LeadMinutesEditor {...p} />}
            />
            {!platformAdmin && (
              <Card>
                <CardHeader title="WhatsApp templates" subtitle="Moved: each business sets its template names, languages and previews in Settings → WhatsApp templates." />
                <div className="p-5">
                  <Link href="/settings/whatsapp" className="font-semibold text-primary underline">
                    Open WhatsApp templates
                  </Link>
                </div>
              </Card>
            )}
          </div>
          {platformAdmin && globalOnly.includes("security.ipWhitelist") && (
            <div className="xl:col-span-2">
              <SettingCard
                settingKey="security.ipWhitelist"
                scope="GLOBAL"
                title="Super-admin IP whitelist"
                description="One IPv4/IPv6 address or CIDR range per line. Leave empty to allow any IP."
                readOnly={false}
                defaults={def("security.ipWhitelist")}
                notice={
                  <Alert tone="warning">
                    <span className="flex gap-2">
                      <ShieldWarning size={20} weight="fill" className="shrink-0" />
                      <span>
                        <b>Lockout risk.</b> When the list is not empty, super-admin requests from any other IP are refused — including from your phone or home
                        network. The server rejects a list that doesn&apos;t include the IP you are using now, but double-check office IPs and VPNs before saving.
                        Recovery requires direct database access.
                      </span>
                    </span>
                  </Alert>
                }
                render={(p) => <IpWhitelistEditor {...p} />}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}

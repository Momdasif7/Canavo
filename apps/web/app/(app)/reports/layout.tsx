"use client";

import {
  Bank,
  Briefcase,
  Buildings,
  ChartLineUp,
  Clock,
  ForkKnife,
  Moped,
  Package,
  Percent,
  Receipt,
  TrendUp,
  UserList,
  UsersThree,
  WarningOctagon,
} from "@phosphor-icons/react";
import { PageContainer } from "@/components/layout/PageHeader";
import { ReportRangeProvider } from "@/components/reports/range";
import { TabNav, type TabLink } from "@/components/reports/TabNav";
import { useSession } from "@/components/providers/SessionProvider";
import { ErrorState } from "@/components/ui/States";

const TABS: TabLink[] = [
  { href: "/reports/sales", label: "Sales", icon: ChartLineUp },
  { href: "/reports/items", label: "Items & categories", icon: ForkKnife },
  { href: "/reports/peak-hours", label: "Peak hours", icon: Clock },
  { href: "/reports/gst", label: "GST", icon: Percent },
  { href: "/reports/gstr1", label: "GSTR-1", icon: Receipt },
  { href: "/reports/profit", label: "Profit", icon: TrendUp },
  { href: "/reports/staff", label: "Staff", icon: UsersThree },
  { href: "/reports/customers", label: "Customers", icon: UserList },
  { href: "/reports/inventory", label: "Inventory", icon: Package },
  { href: "/reports/delivery", label: "Delivery", icon: Moped },
  { href: "/reports/exceptions", label: "Exceptions", icon: WarningOctagon },
  { href: "/reports/settlements", label: "Settlements", icon: Bank },
  { href: "/reports/canteen", label: "Canteen", icon: Briefcase },
  { href: "/reports/outlets", label: "All outlets", icon: Buildings },
];

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  const { can, me } = useSession();
  // The canteen report only for hotels with the Canteen module.
  const tabs = TABS.filter((t) => t.href !== "/reports/canteen" || me?.modules?.includes("CANTEEN"));
  if (!can("report:view")) return <ErrorState message="Your role doesn't have access to reports." />;
  return (
    <ReportRangeProvider>
      <PageContainer>
        <TabNav tabs={tabs} label="Reports" />
        {children}
      </PageContainer>
    </ReportRangeProvider>
  );
}

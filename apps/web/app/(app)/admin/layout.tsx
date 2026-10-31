"use client";

import { usePathname } from "next/navigation";
import { ADMIN_SECTIONS } from "@/components/admin/nav";
import { navAllowed } from "@/components/layout/nav";
import { PageContainer } from "@/components/layout/PageHeader";
import { TabNav } from "@/components/reports/TabNav";
import { useSession } from "@/components/providers/SessionProvider";
import { ErrorState } from "@/components/ui/States";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { me, outletId } = useSession();
  const pathname = usePathname();
  const allowed = me ? ADMIN_SECTIONS.filter((s) => navAllowed(s, { me, outletId })) : [];
  const section = ADMIN_SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`));
  if (!allowed.length || (section && !allowed.includes(section))) {
    return <ErrorState message="Your role doesn't have access to this admin page." />;
  }
  return (
    <PageContainer>
      <TabNav tabs={allowed} label="Admin" />
      {children}
    </PageContainer>
  );
}

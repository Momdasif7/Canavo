"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ADMIN_SECTIONS } from "@/components/admin/nav";
import { navAllowed } from "@/components/layout/nav";
import { useSession } from "@/components/providers/SessionProvider";
import { LoadingState } from "@/components/ui/States";

/** /admin opens the first section this role may use. */
export default function AdminIndex() {
  const router = useRouter();
  const { me, outletId } = useSession();
  const first = me ? ADMIN_SECTIONS.find((s) => navAllowed(s, { me, outletId })) : undefined;
  useEffect(() => {
    if (first) router.replace(first.href);
  }, [first, router]);
  return <LoadingState />;
}

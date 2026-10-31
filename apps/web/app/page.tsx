"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/providers/SessionProvider";
import { firstAllowedRoute } from "@/components/layout/nav";
import { LoadingState } from "@/components/ui/States";

export default function Home() {
  const router = useRouter();
  const { status, me, outletId } = useSession();
  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
    else if (status === "authenticated" && me) router.replace(firstAllowedRoute({ me, outletId }));
  }, [status, me, outletId, router]);
  return <LoadingState label="Opening CANAVO…" />;
}

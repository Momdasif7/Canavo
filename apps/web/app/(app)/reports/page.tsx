"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoadingState } from "@/components/ui/States";

/** /reports opens the sales report (the other reports are tabs). */
export default function ReportsIndex() {
  const router = useRouter();
  useEffect(() => router.replace("/reports/sales"), [router]);
  return <LoadingState />;
}

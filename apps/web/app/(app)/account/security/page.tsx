"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { ChangePasswordCard } from "@/components/account/ChangePasswordCard";
import { SessionsCard } from "@/components/account/SessionsCard";

/** Account → Security: every signed-in user manages their own password and devices here. */
export default function SecurityPage() {
  return (
    <PageContainer>
      <PageHeader title="Security" subtitle="Your password and the devices signed in to your account" />
      <div className="max-w-3xl space-y-5">
        <ChangePasswordCard />
        <SessionsCard />
      </div>
    </PageContainer>
  );
}

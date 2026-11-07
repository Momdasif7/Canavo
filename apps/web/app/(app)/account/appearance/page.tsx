"use client";

import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { AppearancePreview, BusinessBrandCard, MyAppearanceCard } from "@/components/account/AppearanceCards";

/**
 * Account → Appearance: every signed-in user picks their own theme, text size, density and
 * (optionally) accent; owners (outlet:manage) also set the business brand for all staff.
 */
export default function AppearancePage() {
  return (
    <PageContainer>
      <PageHeader title="Appearance" subtitle="Colours, text size and layout — for you, and the brand look for your business" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
        <div className="max-w-3xl space-y-5">
          <MyAppearanceCard />
          <BusinessBrandCard />
        </div>
        <div className="xl:sticky xl:top-4">
          <AppearancePreview />
        </div>
      </div>
    </PageContainer>
  );
}

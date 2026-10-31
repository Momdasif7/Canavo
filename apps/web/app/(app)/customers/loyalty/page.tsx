"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "@phosphor-icons/react";
import { LOYALTY_TIERS, formatINR, loyaltyConfigSchema, type LoyaltyConfig, type LoyaltyTierName } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";
import { TIER_LABELS, TierBadge, decimalOnly, digitsOnly, issuesToErrors } from "@/components/crm/shared";

type PaidTier = Exclude<LoyaltyTierName, "BRONZE">;

interface FormState {
  enabled: boolean;
  earnRupeesPerPoint: string;
  pointValue: string;
  minRedeemPoints: string;
  maxRedeemPercent: string;
  thresholds: Record<PaidTier, string>;
  multipliers: Record<LoyaltyTierName, string>;
  pointsExpiryMonths: string;
  birthdayCouponEnabled: boolean;
  birthdayCouponType: "FLAT" | "PERCENT";
  birthdayCouponValue: string;
  birthdayCouponMaxDiscount: string;
}

function toForm(c: LoyaltyConfig): FormState {
  return {
    enabled: c.enabled,
    earnRupeesPerPoint: String(c.earnRupeesPerPoint),
    pointValue: rupeesInput(c.pointValuePaise),
    minRedeemPoints: String(c.minRedeemPoints),
    maxRedeemPercent: String(c.maxRedeemPercent),
    thresholds: {
      SILVER: rupeesInput(c.tierThresholds.SILVER),
      GOLD: rupeesInput(c.tierThresholds.GOLD),
      PLATINUM: rupeesInput(c.tierThresholds.PLATINUM),
    },
    multipliers: {
      BRONZE: String(c.tierMultipliers.BRONZE),
      SILVER: String(c.tierMultipliers.SILVER),
      GOLD: String(c.tierMultipliers.GOLD),
      PLATINUM: String(c.tierMultipliers.PLATINUM),
    },
    pointsExpiryMonths: String(c.pointsExpiryMonths),
    birthdayCouponEnabled: c.birthdayCouponEnabled,
    birthdayCouponType: c.birthdayCouponType,
    // FLAT birthday coupons store paise (same as Coupon.value); PERCENT stores a percent.
    birthdayCouponValue: c.birthdayCouponType === "FLAT" ? rupeesInput(c.birthdayCouponValue) : String(c.birthdayCouponValue),
    birthdayCouponMaxDiscount: c.birthdayCouponMaxDiscount ? rupeesInput(c.birthdayCouponMaxDiscount) : "",
  };
}

const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

export default function LoyaltySettingsPage() {
  const { me, can } = useSession();
  const toast = useToast();
  const allowed = can("customer:manage");
  const canEdit = me?.role === "SUPER_ADMIN" || me?.role === "BUSINESS_OWNER" || me?.role === "OUTLET_MANAGER";
  const config = useApiQuery<LoyaltyConfig>(allowed ? "loyalty-config" : null, () => api.get<LoyaltyConfig>("/customers/loyalty/config"));
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config.data) setForm(toForm(config.data));
  }, [config.data]);

  if (!allowed)
    return (
      <PageContainer>
        <ErrorState message="You don't have permission to manage loyalty settings." />
      </PageContainer>
    );
  if (config.loading && !config.data) return <LoadingState />;
  if (config.error || !form) return <ErrorState message={config.error ?? "Could not load settings"} onRetry={config.reload} />;

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const dirty = config.data ? JSON.stringify(toForm(config.data)) !== JSON.stringify(form) : false;

  const save = async () => {
    const rupees = (v: string) => parseRupees(v) ?? NaN;
    let bdayValue = form.birthdayCouponType === "FLAT" ? rupees(form.birthdayCouponValue) : num(form.birthdayCouponValue);
    // A disabled coupon keeps its stored value so a blank field doesn't block saving.
    if (!form.birthdayCouponEnabled && !(bdayValue > 0) && config.data) {
      bdayValue = config.data.birthdayCouponType === form.birthdayCouponType ? config.data.birthdayCouponValue : form.birthdayCouponType === "FLAT" ? 5000 : 10;
    }
    const payload = {
      enabled: form.enabled,
      earnRupeesPerPoint: num(form.earnRupeesPerPoint),
      pointValuePaise: rupees(form.pointValue),
      minRedeemPoints: num(form.minRedeemPoints),
      maxRedeemPercent: num(form.maxRedeemPercent),
      tierThresholds: {
        SILVER: rupees(form.thresholds.SILVER),
        GOLD: rupees(form.thresholds.GOLD),
        PLATINUM: rupees(form.thresholds.PLATINUM),
      },
      tierMultipliers: {
        BRONZE: num(form.multipliers.BRONZE),
        SILVER: num(form.multipliers.SILVER),
        GOLD: num(form.multipliers.GOLD),
        PLATINUM: num(form.multipliers.PLATINUM),
      },
      pointsExpiryMonths: num(form.pointsExpiryMonths),
      birthdayCouponEnabled: form.birthdayCouponEnabled,
      birthdayCouponType: form.birthdayCouponType,
      birthdayCouponValue: bdayValue,
      birthdayCouponMaxDiscount: form.birthdayCouponMaxDiscount.trim() ? rupees(form.birthdayCouponMaxDiscount) : null,
    };
    const parsed = loyaltyConfigSchema.safeParse(payload);
    const errs = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    const t = payload.tierThresholds;
    if (!errs["tierThresholds.GOLD"] && t.GOLD < t.SILVER) errs["tierThresholds.GOLD"] = "Must be ≥ Silver";
    if (!errs.birthdayCouponValue && form.birthdayCouponType === "PERCENT" && payload.birthdayCouponValue > 100)
      errs.birthdayCouponValue = "Percent must be ≤ 100";
    if (!errs["tierThresholds.PLATINUM"] && t.PLATINUM < t.GOLD) errs["tierThresholds.PLATINUM"] = "Must be ≥ Gold";
    if (!parsed.success || Object.keys(errs).length) {
      setErrors(errs);
      setError("Please fix the highlighted fields.");
      return;
    }
    setErrors({});
    setError(null);
    setSaving(true);
    try {
      const saved = await api.put<LoyaltyConfig>("/customers/loyalty/config", parsed.data);
      config.setData(saved);
      toast("Loyalty settings saved", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const earn = num(form.earnRupeesPerPoint);
  const pv = parseRupees(form.pointValue);
  const effectiveReturn = earn > 0 && pv ? ((pv / 100 / earn) * 100).toFixed(2) : null;

  return (
    <PageContainer>
      <Link href="/customers" className="mb-3 inline-flex min-h-tap items-center gap-1.5 text-sm font-semibold text-muted hover:text-fg">
        <ArrowLeft size={18} /> Customers
      </Link>
      <PageHeader
        title="Loyalty settings"
        subtitle="Applies to all outlets"
        actions={
          canEdit && (
            <>
              <Button variant="ghost" disabled={!dirty || saving} onClick={() => config.data && setForm(toForm(config.data))}>
                Reset
              </Button>
              <Button onClick={save} loading={saving} disabled={!dirty}>
                Save settings
              </Button>
            </>
          )
        }
      />

      <fieldset disabled={!canEdit || saving} className="space-y-4">
        {!canEdit && <Alert tone="info">Only super admins and outlet managers can change loyalty settings.</Alert>}
        {error && <Alert>{error}</Alert>}

        <Card>
          <CardHeader title="Points" subtitle={effectiveReturn ? `Customers get back about ${effectiveReturn}% of spend (Bronze, before multipliers)` : undefined} />
          <div className="space-y-4 p-5">
            <Toggle checked={form.enabled} onChange={(v) => set("enabled", v)} label="Loyalty programme enabled" description="When off, no points are earned or redeemed." disabled={!canEdit} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Input
                label="Earn 1 point per"
                prefix="₹"
                inputMode="decimal"
                value={form.earnRupeesPerPoint}
                error={errors.earnRupeesPerPoint}
                hint="of bill total, after discounts"
                onChange={(e) => set("earnRupeesPerPoint", decimalOnly(e.target.value))}
              />
              <Input
                label="Value of 1 point"
                prefix="₹"
                inputMode="decimal"
                value={form.pointValue}
                error={errors.pointValuePaise}
                hint="e.g. 0.25 = 25 paise"
                onChange={(e) => set("pointValue", decimalOnly(e.target.value))}
              />
              <Input
                label="Min points to redeem"
                inputMode="numeric"
                value={form.minRedeemPoints}
                error={errors.minRedeemPoints}
                onChange={(e) => set("minRedeemPoints", digitsOnly(e.target.value))}
              />
              <Input
                label="Max bill paid with points (%)"
                inputMode="decimal"
                value={form.maxRedeemPercent}
                error={errors.maxRedeemPercent}
                onChange={(e) => set("maxRedeemPercent", decimalOnly(e.target.value))}
              />
              <Input
                label="Points expire after (months)"
                inputMode="numeric"
                value={form.pointsExpiryMonths}
                error={errors.pointsExpiryMonths}
                hint="0 = never expire"
                onChange={(e) => set("pointsExpiryMonths", digitsOnly(e.target.value))}
              />
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Tiers" subtitle="Tiers are based on lifetime spend. Multipliers boost points earned." />
          <div className="divide-y divide-line">
            {LOYALTY_TIERS.map((tier) => (
              <div key={tier} className="grid items-start gap-4 px-5 py-4 sm:grid-cols-[140px_1fr_1fr]">
                <div className="pt-3">
                  <TierBadge tier={tier} />
                </div>
                {tier === "BRONZE" ? (
                  <p className="pt-3 text-sm text-muted">Every customer starts here</p>
                ) : (
                  <Input
                    label={`${TIER_LABELS[tier]} from lifetime spend`}
                    prefix="₹"
                    inputMode="decimal"
                    value={form.thresholds[tier]}
                    error={errors[`tierThresholds.${tier}`]}
                    onChange={(e) => set("thresholds", { ...form.thresholds, [tier]: decimalOnly(e.target.value) })}
                  />
                )}
                <Input
                  label="Points multiplier"
                  inputMode="decimal"
                  value={form.multipliers[tier]}
                  error={errors[`tierMultipliers.${tier}`]}
                  hint={num(form.multipliers[tier]) >= 0 ? `${form.multipliers[tier] || 0}× points` : undefined}
                  onChange={(e) => set("multipliers", { ...form.multipliers, [tier]: decimalOnly(e.target.value) })}
                />
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Birthday & anniversary coupon" subtitle="Sent on WhatsApp with the wish; valid for 7 days, one use." />
          <div className="space-y-4 p-5">
            <Toggle checked={form.birthdayCouponEnabled} onChange={(v) => set("birthdayCouponEnabled", v)} label="Send an auto-coupon" disabled={!canEdit} />
            {form.birthdayCouponEnabled && (
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold">Discount type</span>
                  <Segmented
                    value={form.birthdayCouponType}
                    onChange={(v) => {
                      // Clear the value: ₹ and % mean different things, so don't carry it across.
                      setForm((f) => (f ? { ...f, birthdayCouponType: v, birthdayCouponValue: "" } : f));
                    }}
                    options={[
                      { value: "PERCENT", label: "Percent" },
                      { value: "FLAT", label: "Flat ₹" },
                    ]}
                  />
                </div>
                <Input
                  label={form.birthdayCouponType === "FLAT" ? "Amount off" : "Percent off"}
                  prefix={form.birthdayCouponType === "FLAT" ? "₹" : "%"}
                  inputMode={form.birthdayCouponType === "FLAT" ? "decimal" : "numeric"}
                  value={form.birthdayCouponValue}
                  error={errors.birthdayCouponValue}
                  onChange={(e) =>
                    set("birthdayCouponValue", form.birthdayCouponType === "FLAT" ? decimalOnly(e.target.value) : digitsOnly(e.target.value))
                  }
                />
                {form.birthdayCouponType === "PERCENT" && (
                  <Input
                    label="Max discount"
                    prefix="₹"
                    inputMode="decimal"
                    value={form.birthdayCouponMaxDiscount}
                    error={errors.birthdayCouponMaxDiscount}
                    hint={form.birthdayCouponMaxDiscount ? `Capped at ${formatINR(parseRupees(form.birthdayCouponMaxDiscount) ?? 0)}` : "Blank = no cap"}
                    onChange={(e) => set("birthdayCouponMaxDiscount", decimalOnly(e.target.value))}
                  />
                )}
              </div>
            )}
          </div>
        </Card>
      </fieldset>
    </PageContainer>
  );
}

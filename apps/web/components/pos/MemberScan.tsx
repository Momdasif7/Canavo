"use client";

import { useEffect, useRef, useState } from "react";
import { Briefcase, IdentificationBadge, Ticket, Wallet, X } from "@phosphor-icons/react";
import { employerShare, formatINR, type MemberLookup } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";

/**
 * Canteen card scan (Phase 5.2). USB RFID / QR readers type the card number and press Enter,
 * so a focused input is all that's needed; employee code or phone work too. The member is
 * attached to the bill (memberId) and their wallet, today's quota and subsidy are shown.
 */
export function MemberScan({
  memberId,
  phone,
  billTotal,
  onAttach,
  onClear,
}: {
  memberId?: string;
  /** Bill's phone (to reload the member of a restored cart) */
  phone: string;
  billTotal: number;
  onAttach: (m: MemberLookup) => void;
  onClear: () => void;
}) {
  const [q, setQ] = useState("");
  const [member, setMember] = useState<MemberLookup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A restored cart keeps memberId only: fetch the card details again.
  useEffect(() => {
    if (!memberId) return setMember(null);
    if (member?.id === memberId || !phone) return;
    let cancelled = false;
    api
      .get<MemberLookup>("/canteen/members/lookup", { query: { q: phone } })
      .then((m) => !cancelled && (m.id === memberId ? setMember(m) : onClear()))
      .catch(() => !cancelled && onClear());
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId]);

  const scan = async () => {
    const v = q.trim();
    if (!v || busy) return;
    setBusy(true);
    setError(null);
    try {
      const m = await api.get<MemberLookup>("/canteen/members/lookup", { query: { q: v } });
      if (!m.memberActive) {
        setError(`${m.name ?? "This member"}'s card is inactive`);
        return;
      }
      setMember(m);
      setQ("");
      onAttach(m);
    } catch (e) {
      setError(/not found/i.test(errorMessage(e)) ? "No member with this card, code or phone" : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (member && memberId === member.id) {
    const share = employerShare(member.rule, billTotal, member.subsidyUsedToday);
    const noMeals = member.mealsLeftToday === 0;
    return (
      <div className="space-y-1.5 rounded-xl border border-primary/40 bg-primary-50/60 px-3 py-2 text-sm dark:bg-primary/10" data-testid="member-card">
        <div className="flex items-center gap-2">
          <IdentificationBadge size={18} className="shrink-0 text-primary" />
          <span className="truncate font-bold">{member.name || `+91 ${member.phone}`}</span>
          {member.employeeCode && <span className="shrink-0 text-xs text-muted">{member.employeeCode}</span>}
          <IconButton label="Remove member" className="ml-auto" onClick={onClear}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {member.account && (
            <span className="flex items-center gap-1">
              <Briefcase size={14} /> {member.account.name}
              {member.department && <span className="text-muted">· {member.department}</span>}
            </span>
          )}
          <span className="flex items-center gap-1">
            <Wallet size={14} /> Wallet <strong className="tabular">{formatINR(member.walletBalance)}</strong>
          </span>
          {member.tokens.map((t) => (
            <span key={t.mealSlotId ?? "any"} className="flex items-center gap-1">
              <Ticket size={14} /> {t.balance} {t.slotName ?? "meal"} token{t.balance === 1 ? "" : "s"}
            </span>
          ))}
          {member.mealsLeftToday !== null && <span className={noMeals ? "font-semibold text-red-600 dark:text-red-300" : ""}>Meals left today: {member.mealsLeftToday}</span>}
        </div>
        {noMeals ? (
          <p className="rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-200" role="alert">
            Today&apos;s meal quota is used up. Remove the card to bill at full price.
          </p>
        ) : (
          member.account?.active &&
          member.rule && (
            <p className="text-xs">
              Company pays <strong className="tabular">{formatINR(share)}</strong>
              {member.slot && <span className="text-muted"> ({member.slot.name})</span>} · employee pays <strong className="tabular">{formatINR(billTotal - share)}</strong>
            </p>
          )
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-2">
        <Input
          ref={inputRef}
          label="Canteen card"
          wrapperClassName="flex-1"
          placeholder="Scan card, or type employee code / phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void scan();
            }
          }}
          prefix={busy ? <Spinner className="h-4 w-4" /> : <IdentificationBadge size={18} />}
          autoComplete="off"
          data-testid="member-scan"
        />
        <Button variant="outline" size="sm" disabled={!q.trim() || busy} onClick={() => void scan()}>
          Find
        </Button>
      </div>
      {error && <p className="text-xs font-semibold text-red-600 dark:text-red-300">{error}</p>}
    </div>
  );
}

import clsx from "clsx";
import {
  Bell,
  CalendarCheck,
  CalendarX,
  ChartLineUp,
  ClockCountdown,
  CookingPot,
  CurrencyInr,
  ForkKnife,
  HandCoins,
  HandWaving,
  Moped,
  Package,
  Receipt,
  SquaresFour,
  Timer,
  Truck,
  UserCircleMinus,
  UserList,
  WarningCircle,
  XCircle,
  SlidersHorizontal,
  type Icon,
} from "@phosphor-icons/react";

const TONE = {
  orange: "bg-primary-100 text-primary-700 dark:bg-primary/15 dark:text-primary-200",
  green: "bg-secondary-50 text-secondary-700 dark:bg-secondary/25 dark:text-green-200",
  red: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  sky: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-200",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-200",
  rose: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-200",
  teal: "bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-200",
  indigo: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-200",
  gray: "bg-surface-2 text-muted",
} as const;

/** Icon + tint per notification kind ("kot.new", "inventory.low", "attendance.late", "delivery", …). First match wins. */
const KINDS: { match: RegExp; icon: Icon; tone: string; label: string }[] = [
  { match: /^kot\.cancel/, icon: XCircle, tone: TONE.red, label: "Order cancelled" },
  { match: /^kot/, icon: CookingPot, tone: TONE.orange, label: "Kitchen" },
  { match: /^order\.ready/, icon: ForkKnife, tone: TONE.green, label: "Order ready" },
  { match: /^order\.cancel/, icon: XCircle, tone: TONE.red, label: "Bill cancelled" },
  { match: /^payment/, icon: CurrencyInr, tone: TONE.green, label: "Payment" },
  { match: /^(order|bill)/, icon: Receipt, tone: TONE.green, label: "Orders" },
  { match: /^delivery\.(late|unassigned)/, icon: WarningCircle, tone: TONE.red, label: "Delivery alert" },
  { match: /^delivery\.cash/, icon: HandCoins, tone: TONE.amber, label: "Delivery cash" },
  { match: /^delivery/, icon: Moped, tone: TONE.sky, label: "Delivery" },
  { match: /^table/, icon: HandWaving, tone: TONE.rose, label: "Table" },
  { match: /^reservation\.noshow/, icon: CalendarX, tone: TONE.red, label: "No-show" },
  { match: /^reservation/, icon: SquaresFour, tone: TONE.teal, label: "Reservation" },
  { match: /^leave/, icon: CalendarCheck, tone: TONE.violet, label: "Leave" },
  { match: /^attendance\.(late|not_clocked_in)/, icon: ClockCountdown, tone: TONE.red, label: "Attendance alert" },
  { match: /^attendance\.(early|missed_clock_out)/, icon: UserCircleMinus, tone: TONE.amber, label: "Attendance" },
  { match: /^attendance/, icon: Timer, tone: TONE.violet, label: "Attendance" },
  { match: /^inventory\.transfer/, icon: Truck, tone: TONE.sky, label: "Stock transfer" },
  { match: /^inventory/, icon: Package, tone: TONE.amber, label: "Inventory" },
  { match: /^report/, icon: ChartLineUp, tone: TONE.indigo, label: "Report" },
  { match: /^(crm|customer|offer|coupon)/, icon: UserList, tone: TONE.teal, label: "Customers" },
  { match: /^platform/, icon: SlidersHorizontal, tone: TONE.gray, label: "Platform" },
];

export function notificationKind(kind: string | null | undefined) {
  return KINDS.find((k) => kind && k.match.test(kind)) ?? { icon: Bell, tone: TONE.gray, label: "Notification" };
}

export function NotificationIcon({ kind, className, size = 18 }: { kind: string | null | undefined; className?: string; size?: number }) {
  const k = notificationKind(kind);
  const I = k.icon;
  return (
    <span className={clsx("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", k.tone, className)} title={k.label} aria-label={k.label} role="img">
      <I size={size} weight="duotone" />
    </span>
  );
}

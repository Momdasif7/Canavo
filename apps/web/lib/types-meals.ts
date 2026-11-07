/** Phase 5.3 / 5.4 (CANTEEN): meal slots, pre-orders, production plan, subscriptions. */
import { addDaysISO, todayISO } from "./dates";

export interface MealSlot {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  preorderCutoff: string | null;
  active: boolean;
  sortOrder: number;
  itemCount?: number;
}

export interface SlotsResponse {
  slots: MealSlot[];
  currentSlotId: string | null;
  warnings: string[];
}

export interface CanteenPreorder {
  id: string;
  invoiceNumber: string;
  mealSlotId: string;
  scheduledFor: string;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  status: "OPEN" | "PAID" | "CANCELLED";
  grandTotal: number;
  amountPaid: number;
  refunded: boolean;
  servedAt: string | null;
  subscriptionId: string | null;
  items: { id: string; name: string; quantity: number; menuItemId: string }[];
}

export interface PreordersResponse {
  date: string;
  slots: { id: string; name: string; startTime: string; endTime: string; cutoffAt: string | null }[];
  preorders: CanteenPreorder[];
}

export interface PlanLine {
  menuItemId: string;
  variantId: string | null;
  name: string;
  preorders: number;
  subscriptions: number;
  confirmed: number;
  expectedWalkIn: number;
}

export interface ProductionPlan {
  date: string;
  slots: { slot: Pick<MealSlot, "id" | "name" | "startTime" | "endTime">; items: PlanLine[]; totals: Omit<PlanLine, "menuItemId" | "variantId" | "name"> }[];
  ingredients: { inventoryItemId: string; name: string; unit: string; confirmed: number; withWalkIn: number; inStock: number; short: number }[];
  inventory: boolean;
}

export interface MealSubscription {
  id: string;
  customerId: string;
  slotId: string;
  menuItemId: string;
  daysOfWeek: number[];
  startDate: string;
  endDate: string;
  pricePerMeal: number;
  mealCount: number;
  status: "ACTIVE" | "PAUSED" | "CANCELLED";
  refundedMeals: number;
  notes: string | null;
  slot: { id: string; name: string };
  menuItem: { id: string; name: string };
  customer: { id: string; name: string | null; phone: string } | null;
  order: { id: string; invoiceNumber: string; grandTotal: number; refundedAmount: number } | null;
  skips: { date: string }[];
  meals: { date: string; orderId: string }[];
  delivered: number;
  remaining: number;
}

export const tomorrowISO = () => addDaysISO(todayISO(), 1);

export const PAY_MODES = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "CARD", label: "Card" },
  { value: "KHATA", label: "Khata (credit)" },
] as const;
export type PayMode = (typeof PAY_MODES)[number]["value"];

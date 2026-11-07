"use client";

import { useState } from "react";
import { DownloadSimple, Printer } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { downloadApiFile } from "@/lib/download";
import { tomorrowISO, type ProductionPlan } from "@/lib/types-meals";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Td, Th, Tr } from "@/components/ui/Table";

/**
 * Canteen → Production plan: what the kitchen makes on a day. Confirmed portions = pre-orders +
 * meal-plan meals; expected walk-ins (average of the last 4 same weekdays) are shown separately.
 */
export default function ProductionPage() {
  const toast = useToast();
  const [date, setDate] = useState(tomorrowISO());
  const q = useApiQuery(`canteen-production-${date}`, () => api.get<ProductionPlan>("/canteen/production", { query: { date } }));

  const download = (format: "xlsx" | "pdf") =>
    void downloadApiFile("/canteen/production", { date, format }, `production_${date}.${format}`).catch((e) => toast(errorMessage(e), "error"));

  return (
    <PageContainer>
      <div className="print:hidden">
        <PageHeader
          title="Production plan"
          subtitle="Confirmed = pre-orders + meal plans. Expected walk-ins come from the last 4 same weekdays in each slot."
          actions={
            <>
              <Input aria-label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <Button variant="outline" icon={<DownloadSimple size={18} />} onClick={() => download("xlsx")}>
                Excel
              </Button>
              <Button variant="outline" icon={<DownloadSimple size={18} />} onClick={() => download("pdf")}>
                PDF
              </Button>
              <Button icon={<Printer size={18} />} onClick={() => window.print()} disabled={!q.data}>
                Print
              </Button>
            </>
          }
        />
      </div>
      {q.error && !q.data ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !q.data ? (
        <LoadingState />
      ) : (
        <div className="print-sheet space-y-5">
          <h2 className="hidden text-xl font-bold print:block">Production plan · {q.data.date}</h2>
          {q.data.slots.map((s) => (
            <Card key={s.slot.id}>
              <CardHeader title={`${s.slot.name} · ${s.slot.startTime}–${s.slot.endTime}`} subtitle={`${s.totals.confirmed} confirmed · about ${s.totals.expectedWalkIn} walk-ins`} />
              {s.items.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">Nothing booked and no recent walk-ins.</p>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Item</Th>
                      <Th className="text-right">Pre-orders</Th>
                      <Th className="text-right">Meal plans</Th>
                      <Th className="text-right">Confirmed</Th>
                      <Th className="text-right">Expected walk-in</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {s.items.map((l) => (
                      <Tr key={`${l.menuItemId}-${l.variantId ?? ""}`}>
                        <Td>{l.name}</Td>
                        <Td className="tabular text-right">{l.preorders}</Td>
                        <Td className="tabular text-right">{l.subscriptions}</Td>
                        <Td className="tabular text-right font-semibold">{l.confirmed}</Td>
                        <Td className="tabular text-right text-muted">{l.expectedWalkIn}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          ))}
          {q.data.inventory && (
            <Card>
              <CardHeader title="Ingredients" subtitle="From recipes, for the whole day, against current stock." />
              {q.data.ingredients.length === 0 ? (
                <p className="px-5 py-4 text-sm text-muted">No recipes for these items.</p>
              ) : (
                <Table>
                  <THead>
                    <tr>
                      <Th>Ingredient</Th>
                      <Th className="text-right">For confirmed</Th>
                      <Th className="text-right">With walk-ins</Th>
                      <Th className="text-right">In stock</Th>
                      <Th className="text-right">Short</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {q.data.ingredients.map((i) => (
                      <Tr key={i.inventoryItemId}>
                        <Td>
                          {i.name} <span className="text-xs text-muted">{i.unit.toLowerCase()}</span>
                        </Td>
                        <Td className="tabular text-right">{i.confirmed}</Td>
                        <Td className="tabular text-right">{i.withWalkIn}</Td>
                        <Td className="tabular text-right">{i.inStock}</Td>
                        <Td className={`tabular text-right ${i.short > 0 ? "font-bold text-red-600" : "text-muted"}`}>{i.short}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          )}
        </div>
      )}
    </PageContainer>
  );
}

"use client";

import { useMemo, useState } from "react";
import { DownloadSimple, MagnifyingGlass } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { downloadApiFile } from "@/lib/download";
import { fuzzyFilter } from "@/lib/fuzzy";
import type { Costing, CostingRow } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Stat } from "./common";
import { foodCostTone } from "./RecipeEditor";

export function RecipeCosting({ version, onOpen }: { version: number; onOpen: (row: CostingRow) => void }) {
  const { outletId } = useSession();
  const toast = useToast();
  const q = useApiQuery<Costing>(outletId ? `inv-costing:${outletId}:${version}` : null, () => api.get<Costing>("/inventory/recipes/costing"));
  const [missingOnly, setMissingOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [downloading, setDownloading] = useState(false);

  const rows = useMemo(() => {
    const list = (q.data?.items ?? []).filter((r) => !missingOnly || !r.hasRecipe);
    return fuzzyFilter(list, search, (r) => `${r.name} ${r.variantName ?? ""} ${r.category}`);
  }, [q.data, missingOnly, search]);

  const download = async () => {
    setDownloading(true);
    try {
      await downloadApiFile("/inventory/recipes/costing", { format: "xlsx" }, "recipe_costing.xlsx");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setDownloading(false);
    }
  };

  if (q.loading && !q.data) return <LoadingState />;
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  const s = q.data?.summary;
  const missing = s ? s.menuRows - s.withRecipe : 0;

  return (
    <div className="space-y-4">
      {s && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Avg food cost"
            value={s.avgFoodCostPercent != null ? `${s.avgFoodCostPercent}%` : "—"}
            tone={s.avgFoodCostPercent == null ? undefined : foodCostTone(s.avgFoodCostPercent) === "success" ? "success" : foodCostTone(s.avgFoodCostPercent) === "warning" ? "warning" : "danger"}
          />
          <Stat label="With recipe" value={`${s.withRecipe} / ${s.menuRows}`} note="Menu items & variants" />
          <Stat label="Missing recipe" value={missing} tone={missing > 0 ? "warning" : undefined} />
          <Stat label="Target" value="≤ 30%" note="Green ≤30 · amber ≤40 · red >40" />
        </div>
      )}
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <Input
            type="search"
            aria-label="Search costing"
            placeholder="Search item or category"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
            wrapperClassName="w-full sm:w-72"
          />
          <Toggle checked={missingOnly} onChange={setMissingOnly} label="Missing recipe only" />
          <Button variant="outline" icon={<DownloadSimple size={18} />} loading={downloading} onClick={download} className="ml-auto">
            Download xlsx
          </Button>
        </div>
        {rows.length === 0 ? (
          <EmptyState title={missingOnly ? "Every item has a recipe" : "No menu items"} />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Item</Th>
                <Th>Category</Th>
                <Th className="text-right">Price</Th>
                <Th className="text-right">Net of GST</Th>
                <Th className="text-right">Ingredient cost</Th>
                <Th className="text-right">Food cost</Th>
                <Th className="text-right">Margin</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <Tr key={`${r.menuItemId}:${r.variantId ?? ""}`} onClick={() => onOpen(r)} title="Open in recipe editor">
                  <Td>
                    <span className="font-semibold">{r.name}</span>
                    {r.variantName && <span className="text-muted"> · {r.variantName}</span>}
                  </Td>
                  <Td className="text-muted">{r.category}</Td>
                  <Td className="tabular text-right">{formatINR(r.price)}</Td>
                  <Td className="tabular text-right">{formatINR(r.netPrice)}</Td>
                  <Td className="tabular text-right">{r.hasRecipe ? formatINR(r.cost) : "—"}</Td>
                  <Td className="text-right">
                    {r.hasRecipe ? (
                      <Badge tone={foodCostTone(r.foodCostPercent)}>{r.foodCostPercent != null ? `${r.foodCostPercent}%` : "—"}</Badge>
                    ) : (
                      <Badge>No recipe</Badge>
                    )}
                  </Td>
                  <Td className={`tabular text-right font-semibold ${r.hasRecipe && r.margin < 0 ? "text-red-600 dark:text-red-400" : ""}`}>
                    {r.hasRecipe ? formatINR(r.margin) : "—"}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

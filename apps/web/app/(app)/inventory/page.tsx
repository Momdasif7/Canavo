"use client";

import { useCallback, useState } from "react";
import { ArrowsDownUp, MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { InventoryLowEvent, ItemCategory, LookupItem, LowStockAlerts, StockItem, StockItemList } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select, Toggle } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InventoryTabs } from "@/components/inventory/InventoryTabs";
import { ItemFormDialog, type ItemFormTarget } from "@/components/inventory/ItemFormDialog";
import { AdjustStockDialog } from "@/components/inventory/AdjustStockDialog";
import { WastageDialog } from "@/components/inventory/WastageDialog";
import { ItemDetailSheet } from "@/components/inventory/ItemDetailSheet";
import { LowStockBanner } from "@/components/inventory/LowStockBanner";
import { CameraScanButton, ScanInput } from "@/components/inventory/Scanner";
import { useStockItems } from "@/components/inventory/common";
import { UNIT_LABELS, formatQty, qtyWithUnit } from "@/components/inventory/units";

export default function StockPage() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const manage = can("inventory:manage");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [lowOnly, setLowOnly] = useState(false);
  const debounced = useDebouncedValue(search.trim(), 300);

  const listKey = outletId ? `inv-items:${outletId}:${debounced}:${category}:${lowOnly}` : null;
  const list = useApiQuery<StockItemList>(listKey, () =>
    api.get<StockItemList>("/inventory/items", { query: { search: debounced || undefined, category: category || undefined, lowStock: lowOnly ? "1" : undefined } }),
  );
  const categories = useApiQuery<ItemCategory[]>(outletId ? `inv-cats:${outletId}` : null, () => api.get<ItemCategory[]>("/inventory/items/categories"));
  const alerts = useApiQuery<LowStockAlerts>(outletId ? `inv-alerts:${outletId}` : null, () => api.get<LowStockAlerts>("/inventory/alerts"));
  // Full unfiltered list for the wastage picker.
  const allItems = useStockItems();

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [formTarget, setFormTarget] = useState<ItemFormTarget>(null);
  const [adjusting, setAdjusting] = useState<StockItem | null>(null);
  const [wastage, setWastage] = useState<{ open: boolean; item: StockItem | null }>({ open: false, item: null });
  const [deactivating, setDeactivating] = useState<StockItem | null>(null);
  const [notFoundCode, setNotFoundCode] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  const refreshAll = useCallback(() => {
    void list.reload();
    void alerts.reload();
    void allItems.reload();
    void categories.reload();
    setDetailVersion((v) => v + 1);
  }, [list, alerts, allItems, categories]);

  useSocketEvent<InventoryLowEvent>("inventory:low", (p) => {
    const names = p.items.map((i) => i.name);
    toast(`Low stock: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""}`, "info");
    void alerts.reload();
    void list.reload();
  });
  useSocketEvent("inventory:changed", () => {
    void list.reload();
    void alerts.reload();
  });

  const lookup = async (code: string) => {
    setScanning(true);
    try {
      const item = await api.get<LookupItem>("/inventory/items/lookup", { query: { code } });
      setDetailId(item.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        toast(`No item found for “${code}”`, "error");
        if (manage) setNotFoundCode(code);
      } else toast(errorMessage(e), "error");
    } finally {
      setScanning(false);
    }
  };

  const deactivate = async () => {
    if (!deactivating) return;
    try {
      await api.del(`/inventory/items/${deactivating.id}`);
    } catch (e) {
      throw new Error(errorMessage(e));
    }
    toast(`${deactivating.name} deactivated`, "success");
    setDetailId(null);
    refreshAll();
  };

  const items = list.data?.items ?? [];
  const totals = list.data?.totals;

  return (
    <PageContainer>
      <PageHeader
        title="Inventory"
        subtitle={totals ? `${totals.count} items · stock value ${formatINR(totals.value)}` : "Ingredients and supplies at this outlet"}
        actions={
          manage && (
            <>
              <Button variant="outline" icon={<Trash size={20} />} onClick={() => setWastage({ open: true, item: null })}>
                Record wastage
              </Button>
              <Button icon={<Plus size={20} />} onClick={() => setFormTarget({ mode: "create" })}>
                Add item
              </Button>
            </>
          )
        }
      />
      <InventoryTabs />
      <LowStockBanner alerts={alerts.data} onOpenItem={setDetailId} />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <Input
            type="search"
            aria-label="Search items"
            placeholder="Search name or SKU"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
            wrapperClassName="w-full sm:w-64"
          />
          <Select aria-label="Category filter" value={category} onChange={(e) => setCategory(e.target.value)} wrapperClassName="w-full sm:w-48">
            <option value="">All categories</option>
            {(categories.data ?? []).map((c) => (
              <option key={c.category} value={c.category}>
                {c.category} ({c.count})
              </option>
            ))}
          </Select>
          <div className="w-full sm:w-auto">
            <Toggle checked={lowOnly} onChange={setLowOnly} label="Low stock only" />
          </div>
          <div className="flex w-full items-center gap-2 lg:ml-auto lg:w-auto">
            <ScanInput onScan={lookup} busy={scanning} className="flex-1 lg:w-64" />
            <CameraScanButton onScan={lookup} />
          </div>
        </div>

        {list.loading && !list.data ? (
          <LoadingState />
        ) : list.error && !list.data ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : items.length === 0 ? (
          <EmptyState
            title={debounced || category || lowOnly ? "No items match these filters" : "No stock items yet"}
            description={debounced || category || lowOnly ? undefined : manage ? "Use Add item above to start tracking ingredients and supplies." : "No ingredients or supplies are tracked yet."}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Item</Th>
                <Th>Category</Th>
                <Th className="text-right">In stock</Th>
                <Th className="text-right">Cost / unit</Th>
                <Th className="text-right">Value</Th>
                <Th className="text-right">Reorder at</Th>
                {manage && <Th />}
              </tr>
            </THead>
            <tbody>
              {items.map((i) => (
                <Tr
                  key={i.id}
                  onClick={() => setDetailId(i.id)}
                  className={i.lowStock ? (i.quantity <= 0 ? "bg-red-50/70 dark:bg-red-500/10" : "bg-amber-50/70 dark:bg-amber-500/10") : undefined}
                  data-testid="stock-row"
                >
                  <Td>
                    <p className="font-semibold">{i.name}</p>
                    <p className="text-xs text-muted">
                      {[i.sku, i.barcode].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </Td>
                  <Td className="text-muted">{i.category}</Td>
                  <Td className="tabular whitespace-nowrap text-right">
                    <span className={`font-bold ${i.quantity < 0 ? "text-red-600 dark:text-red-400" : ""}`}>{formatQty(i.quantity)}</span>{" "}
                    <span className="text-xs text-muted">{UNIT_LABELS[i.unit]}</span>
                    {i.lowStock && (
                      <div className="mt-1">
                        <Badge tone={i.quantity <= 0 ? "danger" : "warning"}>{i.quantity <= 0 ? "Out of stock" : "Low stock"}</Badge>
                      </div>
                    )}
                  </Td>
                  <Td className="tabular whitespace-nowrap text-right">{formatINR(i.costPerUnit)}</Td>
                  <Td className="tabular whitespace-nowrap text-right font-semibold">{formatINR(i.value)}</Td>
                  <Td className="tabular whitespace-nowrap text-right text-muted">{i.reorderLevel ? qtyWithUnit(i.reorderLevel, i.unit) : "—"}</Td>
                  {manage && (
                    <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <IconButton label={`Adjust stock of ${i.name}`} onClick={() => setAdjusting(i)}>
                        <ArrowsDownUp size={20} />
                      </IconButton>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="bg-surface-2 font-semibold">
                  <Td colSpan={2}>
                    {totals.count} items{totals.lowStock > 0 && <span className="text-amber-700 dark:text-amber-300"> · {totals.lowStock} low</span>}
                  </Td>
                  <Td />
                  <Td />
                  <Td className="tabular text-right">{formatINR(totals.value)}</Td>
                  <Td />
                  {manage && <Td />}
                </tr>
              </tfoot>
            )}
          </Table>
        )}
      </Card>

      <ItemDetailSheet
        itemId={detailId}
        version={detailVersion}
        onClose={() => setDetailId(null)}
        onEdit={(d) => setFormTarget({ mode: "edit", item: d })}
        onAdjust={(d) => setAdjusting(d)}
        onWastage={(d) => setWastage({ open: true, item: d })}
        onDeactivate={(d) => setDeactivating(d)}
      />
      <ItemFormDialog
        target={formTarget}
        categories={categories.data ?? []}
        onClose={() => setFormTarget(null)}
        onSaved={() => refreshAll()}
      />
      <AdjustStockDialog item={adjusting} onClose={() => setAdjusting(null)} onSaved={refreshAll} />
      <WastageDialog
        open={wastage.open}
        initialItem={wastage.item}
        items={allItems.data?.items ?? []}
        onClose={() => setWastage({ open: false, item: null })}
        onSaved={refreshAll}
      />
      <ConfirmDialog
        open={!!deactivating}
        title={`Deactivate ${deactivating?.name ?? "item"}?`}
        description="The item is hidden from stock lists and recipes using it stop deducting. History is kept."
        confirmLabel="Deactivate"
        onConfirm={deactivate}
        onClose={() => setDeactivating(null)}
      />
      <ConfirmDialog
        open={!!notFoundCode}
        tone="primary"
        title="Item not found"
        description={`No item has barcode or SKU “${notFoundCode ?? ""}”. Create a new item with this barcode?`}
        confirmLabel="Create item"
        onConfirm={() => setFormTarget({ mode: "create", barcode: notFoundCode ?? undefined })}
        onClose={() => setNotFoundCode(null)}
      />
    </PageContainer>
  );
}

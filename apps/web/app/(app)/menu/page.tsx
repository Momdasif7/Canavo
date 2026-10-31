"use client";

import { useMemo, useState } from "react";
import { FileArrowUp, ImageSquare, Lightning, MagnifyingGlass, PencilSimple, Plus } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { fuzzyFilter } from "@/lib/fuzzy";
import { mediaUrl } from "@/lib/media";
import type { FoodType, ItemStatus, Menu, MenuItem } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select, Toggle } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { FoodMark } from "@/components/ui/FoodMark";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { CategoryManager } from "@/components/menu/CategoryManager";
import { ItemForm } from "@/components/menu/ItemForm";
import { ImportDialog } from "@/components/menu/ImportDialog";

/** What a manager set. The effective `status` also turns OUT_OF_STOCK when an ingredient runs out — never save that one. */
const manualStatus = (i: MenuItem): ItemStatus => i.manualStatus ?? i.status;
/** Out of stock automatically (an ingredient ran out) while the manager has it available. */
const autoOut = (i: MenuItem) => !!i.stockOut && manualStatus(i) === "AVAILABLE";

type StatusFilter = ItemStatus | "AUTO_OUT";

export default function MenuPage() {
  const { outletId } = useSession();
  const toast = useToast();
  const menu = useApiQuery<Menu>(outletId ? `menu-admin:${outletId}` : null, () => api.get<Menu>("/menu"));
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter | "">("");
  const [foodType, setFoodType] = useState<FoodType | "">("");
  /** undefined = new item, string = edit, null = closed */
  const [editing, setEditing] = useState<string | null | undefined>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  // Availability changed elsewhere (another device, or stock ran out / was restocked).
  useSocketEvent("menu:changed", () => void menu.reload());

  const categories = useMemo(() => menu.data?.categories ?? [], [menu.data]);
  const catName = useMemo(() => {
    const byId = new Map(categories.map((c) => [c.id, c]));
    return (id: string) => {
      const c = byId.get(id);
      if (!c) return "—";
      const parent = c.parentId ? byId.get(c.parentId) : undefined;
      return parent ? `${parent.name} › ${c.name}` : c.name;
    };
  }, [categories]);

  const items = useMemo(() => {
    let list = menu.data?.items ?? [];
    if (category) {
      const ids = new Set([category, ...categories.filter((c) => c.parentId === category).map((c) => c.id)]);
      list = list.filter((i) => ids.has(i.categoryId));
    }
    if (status === "AUTO_OUT") list = list.filter(autoOut);
    else if (status) list = list.filter((i) => i.status === status);
    if (foodType) list = list.filter((i) => i.foodType === foodType);
    return fuzzyFilter(list, search, (i) => i.name);
  }, [menu.data, category, categories, status, foodType, search]);

  /**
   * Outlet-level availability (doesn't change other outlets). Preserves any price override.
   * Works on `manualStatus`, so an automatic out-of-stock never gets saved as a manual one.
   */
  const toggleAvailability = async (item: MenuItem) => {
    const next: ItemStatus = manualStatus(item) === "AVAILABLE" ? "OUT_OF_STOCK" : "AVAILABLE";
    const effective: ItemStatus = next === "AVAILABLE" && item.stockOut ? "OUT_OF_STOCK" : next;
    setToggling(item.id);
    menu.setData((m) => m && { ...m, items: m.items.map((i) => (i.id === item.id ? { ...i, manualStatus: next, status: effective } : i)) });
    try {
      await api.put(`/menu/items/${item.id}/override`, { status: next });
    } catch (e) {
      menu.setData((m) => m && { ...m, items: m.items.map((i) => (i.id === item.id ? { ...i, manualStatus: item.manualStatus, status: item.status } : i)) });
      toast(errorMessage(e), "error");
    } finally {
      setToggling(null);
    }
  };

  if (menu.loading && !menu.data) return <LoadingState />;
  if (menu.error && !menu.data) return <ErrorState message={menu.error} onRetry={menu.reload} />;

  const defaultCategory = category ?? categories[0]?.id ?? "";

  return (
    <PageContainer>
      <PageHeader
        title="Menu"
        subtitle={`${menu.data?.items.length ?? 0} items · ${categories.length} categories`}
        actions={
          <>
            <Button variant="outline" icon={<FileArrowUp size={20} />} onClick={() => setImportOpen(true)} title="Add or update many items at once from an Excel sheet">
              Bulk upload
            </Button>
            <Button icon={<Plus size={20} />} onClick={() => setEditing(undefined)} disabled={!categories.length} title={categories.length ? undefined : "Create a category first"}>
              New item
            </Button>
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[280px_1fr]">
        <div>
          <CategoryManager categories={categories} items={menu.data?.items ?? []} selected={category} onSelect={setCategory} onChanged={menu.reload} />
        </div>
        <Card className="min-w-0">
          <div className="flex flex-wrap gap-3 border-b border-line p-4">
            <Input
              wrapperClassName="min-w-[220px] flex-1"
              type="search"
              placeholder="Search items"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              prefix={<MagnifyingGlass size={18} />}
            />
            <Select aria-label="Status" wrapperClassName="w-44" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter | "")}>
              <option value="">All statuses</option>
              <option value="AVAILABLE">Available</option>
              <option value="OUT_OF_STOCK">Out of stock</option>
              <option value="AUTO_OUT">Auto: ingredient ran out</option>
              <option value="HIDDEN">Hidden</option>
            </Select>
            <Select aria-label="Food type" wrapperClassName="w-36" value={foodType} onChange={(e) => setFoodType(e.target.value as FoodType | "")}>
              <option value="">All types</option>
              <option value="VEG">Veg</option>
              <option value="EGG">Egg</option>
              <option value="NON_VEG">Non-veg</option>
            </Select>
          </div>
          {items.length === 0 ? (
            <EmptyState title="No items" description={search ? "Try a different search." : "Add an item, or use Bulk upload to add many from an Excel sheet."} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Item</Th>
                  <Th>Category</Th>
                  <Th className="text-right">Price</Th>
                  <Th className="text-right">Tax</Th>
                  <Th>Station</Th>
                  <Th>In stock here</Th>
                  <Th />
                </tr>
              </THead>
              <tbody>
                {items.map((i) => (
                  <Tr key={i.id}>
                    <Td>
                      <div className="flex items-center gap-3">
                        <ItemThumb key={i.imageUrl ?? ""} url={i.imageUrl} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <FoodMark type={i.foodType} />
                            <span className="font-semibold">{i.name}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-1 pl-6">
                            {i.variants.length > 0 && <Badge>{i.variants.length} sizes</Badge>}
                            {i.addons.length > 0 && <Badge>{i.addons.length} add-ons</Badge>}
                            {i.availableFrom && i.availableTo && <Badge tone="info">{i.availableFrom}–{i.availableTo}</Badge>}
                            {manualStatus(i) === "HIDDEN" && <Badge tone="neutral">Hidden</Badge>}
                            {autoOut(i) && (
                              <Badge tone="warning" className="whitespace-normal">
                                <Lightning size={12} weight="fill" className="shrink-0" />
                                Auto: out of stock{i.stockOutReason ? ` — ${i.stockOutReason} ran out` : ""}
                              </Badge>
                            )}
                            {!autoOut(i) && manualStatus(i) !== "HIDDEN" && (i.unavailableVariantIds?.length ?? 0) > 0 && (
                              <Badge tone="warning" className="whitespace-normal">
                                <Lightning size={12} weight="fill" className="shrink-0" />
                                {i.variants
                                  .filter((v) => i.unavailableVariantIds!.includes(v.id))
                                  .map((v) => v.name)
                                  .join(", ")}{" "}
                                out of stock
                              </Badge>
                            )}
                          </div>
                          {(autoOut(i) || (manualStatus(i) !== "HIDDEN" && (i.unavailableVariantIds?.length ?? 0) > 0)) && (
                            <p className="mt-0.5 pl-6 text-xs text-muted">Comes back automatically when restocked</p>
                          )}
                        </div>
                      </div>
                    </Td>
                    <Td className="text-muted">{catName(i.categoryId)}</Td>
                    <Td className="tabular text-right font-bold">
                      {formatINR(i.price)}
                      {i.price !== i.basePrice && <span className="block text-xs font-normal text-muted line-through">{formatINR(i.basePrice)}</span>}
                    </Td>
                    <Td className="tabular whitespace-nowrap text-right">
                      {i.taxRate ? i.taxRate.name : i.taxRateId === null ? <span className="text-muted">Default</span> : `${i.gstRate}%`}
                    </Td>
                    <Td className="text-muted">{i.kitchenStation}</Td>
                    <Td>
                      {manualStatus(i) === "HIDDEN" ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        <Toggle checked={manualStatus(i) === "AVAILABLE"} disabled={toggling === i.id} onChange={() => toggleAvailability(i)} />
                      )}
                    </Td>
                    <Td className="text-right">
                      <IconButton label={`Edit ${i.name}`} onClick={() => setEditing(i.id)}>
                        <PencilSimple size={20} />
                      </IconButton>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <ItemForm itemId={editing} categories={categories} defaultCategoryId={defaultCategory} onClose={() => setEditing(null)} onSaved={menu.reload} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={menu.reload} />
    </PageContainer>
  );
}

/** Small square photo for the item list, with a neutral placeholder when there is none (or it fails to load). */
function ItemThumb({ url }: { url: string | null | undefined }) {
  const [broken, setBroken] = useState(false);
  const src = broken ? "" : mediaUrl(url);
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-surface-2">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary upload/CDN hosts
        <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <ImageSquare size={20} className="text-muted/60" />
      )}
    </div>
  );
}

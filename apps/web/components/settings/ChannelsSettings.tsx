"use client";

import { useEffect, useState } from "react";
import { ArrowsClockwise, Copy, FloppyDisk, Moped, PlugsConnected } from "@phosphor-icons/react";
import { ORDER_CHANNEL_LABELS, formatINR, type OrderChannel } from "@canavo/shared";
import { api, apiBase, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { ChannelBadge } from "@/components/bills/ChannelBadge";

/** GET /channels/connection (secrets masked as "••••abcd"). */
interface Connection {
  id: string;
  enabled: boolean;
  storeOpen: boolean;
  baseUrl: string;
  externalStoreId: string;
  apiKey: string | null;
  webhookSecret: string | null;
  commission: Partial<Record<OrderChannel, number>>;
  lastMenuSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}
interface FailedPush {
  seq: string;
  payload: { status: string };
  lastError: string | null;
  failedAt: string;
}
interface ChannelItem {
  menuItemId: string;
  name: string;
  category: string;
  externalId: string;
  custom: boolean;
  published: boolean;
  available: boolean;
  price: number | null;
}
interface ChannelOrderRow {
  id: string;
  sourceChannel: OrderChannel;
  channelOrderId: string;
  status: "ACCEPTED" | "REJECTED" | "CANCELLED";
  pushedStatus: string | null;
  pushError: string | null;
  riderStatus: string | null;
  rider: { name?: string; phone?: string } | null;
  channelTotal: number;
  ourTotal: number;
  mismatch: boolean;
  error: string | null;
  createdAt: string;
  order: { id: string; invoiceNumber: string; status: string; grandTotal: number } | null;
}

/** Sources a hub relays; commission is set per source. */
const SOURCES: OrderChannel[] = ["ZOMATO", "SWIGGY", "ONDC", "OTHER"];
const PUSH_LABELS: Record<string, string> = { ACCEPTED: "Accepted", FOOD_READY: "Food ready", DISPATCHED: "Handed to rider", DELIVERED: "Delivered", CANCELLED: "Cancelled" };
const RIDER_LABELS: Record<string, string> = { ASSIGNED: "Rider assigned", AT_STORE: "Rider at store", PICKED_UP: "Picked up", DELIVERED: "Delivered" };

/** Settings → Channels (channel:manage): Zomato / Swiggy and other apps through an order hub. */
export function ChannelsSettings() {
  const { outletId } = useSession();
  const conn = useApiQuery<{ connection: Connection | null; failed: FailedPush[] }>(outletId ? `channel-conn:${outletId}` : null, () => api.get("/channels/connection"));
  if (conn.loading && !conn.data) return <Card><LoadingState /></Card>;
  if (conn.error) return <Card><ErrorState message={conn.error} onRetry={conn.reload} /></Card>;
  if (!conn.data) return null;
  const c = conn.data.connection;
  return (
    <div className="space-y-5">
      <ConnectionCard connection={c} failed={conn.data.failed} onChange={conn.reload} />
      {c && (
        <>
          <StoreCard connection={c} onChange={conn.reload} />
          <ChannelOrdersCard />
          <ItemMappingCard />
        </>
      )}
    </div>
  );
}

function ConnectionCard({ connection: c, failed, onChange }: { connection: Connection | null; failed: FailedPush[]; onChange: () => Promise<void> }) {
  const toast = useToast();
  const [form, setForm] = useState({ enabled: false, baseUrl: "", externalStoreId: "", apiKey: "", webhookSecret: "", commission: {} as Record<string, string> });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setForm({
      enabled: c?.enabled ?? false,
      baseUrl: c?.baseUrl ?? "",
      externalStoreId: c?.externalStoreId ?? "",
      apiKey: "",
      webhookSecret: "",
      commission: Object.fromEntries(SOURCES.map((s) => [s, c?.commission[s] != null ? String(c.commission[s]) : ""])),
    });
  }, [c]);

  const save = async () => {
    setError(null);
    if (!/^https?:\/\//.test(form.baseUrl.trim())) return setError("Hub address must start with https://");
    if (!form.externalStoreId.trim()) return setError("Enter this outlet's store id at the hub");
    if (!c && (!form.apiKey.trim() || !form.webhookSecret.trim())) return setError("Enter the hub's API key and webhook secret");
    const commission: Record<string, number> = {};
    for (const s of SOURCES) {
      const v = form.commission[s]?.trim();
      if (!v) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) return setError(`${ORDER_CHANNEL_LABELS[s]} commission must be between 0 and 100%`);
      commission[s] = n;
    }
    setSaving(true);
    try {
      await api.put("/channels/connection", {
        enabled: form.enabled,
        baseUrl: form.baseUrl.trim(),
        externalStoreId: form.externalStoreId.trim(),
        commission,
        ...(form.apiKey.trim() && { apiKey: form.apiKey.trim() }),
        ...(form.webhookSecret.trim() && { webhookSecret: form.webhookSecret.trim() }),
      });
      toast("Channel settings saved", "success");
      await onChange();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>("/channels/connection/test");
      if (r.ok) toast("The hub answered — connection works", "success");
      else toast(`Hub test failed: ${r.error}`, "error");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setTesting(false);
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      const r = await api.post<{ retried: number }>("/channels/connection/retry-failed");
      toast(`Sending ${r.retried} update(s) again`, "info");
      await onChange();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setRetrying(false);
    }
  };

  const webhookUrl = c ? `${apiBase()}/channels/hub/${c.id}/webhook` : null;
  const copy = async () => {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      toast("Webhook address copied", "success");
    } catch {
      toast("Could not copy — select the address and copy it", "error");
    }
  };

  return (
    <Card>
      <CardHeader
        title="Order hub connection"
        subtitle="Zomato, Swiggy and other apps reach you through an order hub (UrbanPiper-style). Orders arrive as normal bills, at your menu prices."
        action={
          <div className="flex flex-wrap gap-2">
            {c && (
              <Button variant="outline" icon={<PlugsConnected size={20} />} onClick={() => void test()} loading={testing}>
                Test connection
              </Button>
            )}
            <Button icon={<FloppyDisk size={20} />} onClick={() => void save()} loading={saving}>
              Save
            </Button>
          </div>
        }
      />
      <fieldset disabled={saving} className="space-y-5 p-5">
        {error && <Alert>{error}</Alert>}
        {c?.lastError && (
          <Alert tone="warning">
            {c.lastError}
            {c.lastErrorAt && <span className="block text-xs opacity-80">{formatDateTime(c.lastErrorAt)}</span>}
          </Alert>
        )}
        {failed.length > 0 && (
          <Alert>
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {failed.length} status update(s) could not reach the hub after several tries. Latest: {failed[0].lastError ?? "unknown error"}
              </span>
              <Button size="sm" variant="secondary" onClick={() => void retry()} loading={retrying}>
                Try again
              </Button>
            </span>
          </Alert>
        )}
        <Toggle checked={form.enabled} onChange={(v) => setForm((f) => ({ ...f, enabled: v }))} label="Connection on" description="When off, orders from the hub are refused." />
        <div className="grid gap-4 md:grid-cols-2">
          <Input label="Hub address" type="url" value={form.baseUrl} onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))} placeholder="https://api.your-hub.example" hint="Given by your hub provider" />
          <Input label="Store id at the hub" value={form.externalStoreId} onChange={(e) => setForm((f) => ({ ...f, externalStoreId: e.target.value }))} hint="This outlet's id in the hub's dashboard" />
          <Input
            label="API key"
            type="password"
            autoComplete="new-password"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            placeholder={c?.apiKey ?? "API key"}
            hint={c?.apiKey ? "Saved — leave blank to keep it" : "Used when we send menus and order updates to the hub"}
          />
          <Input
            label="Webhook secret"
            type="password"
            autoComplete="new-password"
            value={form.webhookSecret}
            onChange={(e) => setForm((f) => ({ ...f, webhookSecret: e.target.value }))}
            placeholder={c?.webhookSecret ?? "Shared secret"}
            hint={c?.webhookSecret ? "Saved — leave blank to keep it" : "The hub signs every order it sends with this secret"}
          />
        </div>
        {webhookUrl && (
          <div className="space-y-1">
            <p className="text-sm font-semibold">Webhook address for the hub</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg bg-surface-2 px-3 py-2 text-xs">{webhookUrl}</code>
              <Button size="sm" variant="outline" icon={<Copy size={16} />} onClick={() => void copy()}>
                Copy
              </Button>
            </div>
            <p className="text-xs text-muted">Paste this into the hub&apos;s dashboard so new orders, cancellations and rider updates reach this outlet.</p>
          </div>
        )}
        <section className="space-y-2" aria-label="Commission">
          <h3 className="text-sm font-bold uppercase tracking-wide text-muted">Commission (for reports)</h3>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {SOURCES.map((s) => (
              <Input
                key={s}
                label={`${ORDER_CHANNEL_LABELS[s]} %`}
                inputMode="decimal"
                value={form.commission[s] ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, commission: { ...f.commission, [s]: e.target.value } }))}
                placeholder="0"
              />
            ))}
          </div>
          <p className="text-xs text-muted">The sales report estimates what each app keeps using these percentages.</p>
        </section>
      </fieldset>
    </Card>
  );
}

function StoreCard({ connection: c, onChange }: { connection: Connection; onChange: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"store" | "menu" | null>(null);

  const toggle = async (open: boolean) => {
    setBusy("store");
    try {
      await api.post("/channels/connection/store", { open });
      toast(open ? "You're taking online orders" : "Online orders paused", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
      await onChange();
    }
  };

  const sync = async () => {
    setBusy("menu");
    try {
      const r = await api.post<{ items: number; unavailable: number }>("/channels/connection/menu-sync");
      toast(`Menu sent: ${r.items} items${r.unavailable ? `, ${r.unavailable} marked unavailable` : ""}`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
      await onChange();
    }
  };

  return (
    <Card>
      <CardHeader title="Store" subtitle="Open or close the store on every app at once, and send your current menu." />
      <div className="space-y-4 p-5">
        <Toggle
          checked={c.storeOpen}
          onChange={(v) => void toggle(v)}
          disabled={busy !== null || (!c.enabled && !c.storeOpen)}
          label={c.storeOpen ? "Open — taking orders on the apps" : "Closed — not taking orders"}
          description={c.enabled ? "Close it when the kitchen is too busy or shutting for the day." : "Switch the connection on and save first."}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" icon={<ArrowsClockwise size={20} />} onClick={() => void sync()} loading={busy === "menu"} disabled={busy !== null}>
            Sync menu now
          </Button>
          <span className="text-sm text-muted">{c.lastMenuSyncAt ? `Last sent ${formatDateTime(c.lastMenuSyncAt)}` : "Menu not sent yet"}</span>
        </div>
        <p className="text-xs text-muted">Hidden items are left out; items marked out of stock (by hand or automatically from stock) are sent as unavailable.</p>
      </div>
    </Card>
  );
}

function ChannelOrdersCard() {
  const { outletId } = useSession();
  const toast = useToast();
  const orders = useApiQuery<ChannelOrderRow[]>(outletId ? `channel-orders:${outletId}` : null, () => api.get("/channels/orders"));
  useSocketEvent("channel:order", () => void orders.reload());
  useSocketEvent("channel:rider", () => void orders.reload());
  const [busy, setBusy] = useState<string | null>(null);

  const handOver = async (o: ChannelOrderRow) => {
    if (!o.order) return;
    setBusy(o.id);
    try {
      await api.post(`/channels/orders/${o.order.id}/status`, { status: "DISPATCHED" });
      toast(`${o.order.invoiceNumber}: told ${ORDER_CHANNEL_LABELS[o.sourceChannel]} it's with the rider`, "success");
      setTimeout(() => void orders.reload(), 1500);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader title="Recent channel orders" subtitle="Every order the apps sent, including ones we refused, with what we last told the app." />
      {orders.loading && !orders.data ? (
        <LoadingState />
      ) : orders.error ? (
        <ErrorState message={orders.error} onRetry={orders.reload} />
      ) : !orders.data?.length ? (
        <EmptyState title="No channel orders yet" description="Orders from Zomato, Swiggy and other apps will appear here." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Received</Th>
              <Th>Order</Th>
              <Th>Bill</Th>
              <Th className="text-right">App total</Th>
              <Th className="text-right">Our bill</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </THead>
          <tbody>
            {orders.data.map((o) => (
              <tr key={o.id}>
                <Td className="tabular whitespace-nowrap text-muted">{formatDateTime(o.createdAt)}</Td>
                <Td>
                  <ChannelBadge channel={o.sourceChannel} /> <span className="font-semibold">#{o.channelOrderId}</span>
                </Td>
                <Td>{o.order ? <span className="font-semibold">{o.order.invoiceNumber}</span> : <span className="text-muted">—</span>}</Td>
                <Td className="tabular text-right">{formatINR(o.channelTotal)}</Td>
                <Td className="tabular text-right">
                  {o.order ? formatINR(o.ourTotal) : "—"}
                  {o.mismatch && (
                    <Badge tone="warning" className="ml-2">
                      Differs
                    </Badge>
                  )}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={o.status === "ACCEPTED" ? "success" : "danger"}>{o.status === "ACCEPTED" ? "Accepted" : o.status === "REJECTED" ? "Refused" : "Cancelled"}</Badge>
                    {o.pushedStatus && o.status === "ACCEPTED" && <Badge tone="info">{PUSH_LABELS[o.pushedStatus] ?? o.pushedStatus}</Badge>}
                    {o.riderStatus && (
                      <Badge>
                        <Moped size={12} /> {RIDER_LABELS[o.riderStatus] ?? o.riderStatus}
                        {o.rider?.name ? ` · ${o.rider.name}` : ""}
                      </Badge>
                    )}
                  </div>
                  {(o.error || o.pushError) && <p className="mt-1 max-w-xs text-xs text-red-600">{o.pushError ?? o.error}</p>}
                </Td>
                <Td>
                  {o.status === "ACCEPTED" && o.order?.status !== "CANCELLED" && o.pushedStatus !== "DISPATCHED" && o.pushedStatus !== "DELIVERED" && (
                    <Button size="sm" variant="outline" onClick={() => void handOver(o)} loading={busy === o.id}>
                      Handed to rider
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function ItemMappingCard() {
  const { outletId } = useSession();
  const toast = useToast();
  const items = useApiQuery<ChannelItem[]>(outletId ? `channel-items:${outletId}` : null, () => api.get("/channels/items"));
  const [edits, setEdits] = useState<Record<string, string>>({});

  const saveId = async (it: ChannelItem) => {
    const v = edits[it.menuItemId];
    // Blank = our own id (the default).
    if (v === undefined || v.trim() === (it.custom ? it.externalId : "")) return;
    try {
      await api.put(`/channels/items/${it.menuItemId}`, { externalId: v.trim() || null });
      toast(`${it.name}: id saved — sync the menu to send it`, "success");
      setEdits(({ [it.menuItemId]: _, ...rest }) => rest);
      await items.reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <Card>
      <CardHeader
        title="Item ids on the apps"
        subtitle="Each menu item is sent with an id; orders come back with it. Keep our id unless your hub already uses its own codes for these items."
      />
      {items.loading && !items.data ? (
        <LoadingState />
      ) : items.error ? (
        <ErrorState message={items.error} onRetry={items.reload} />
      ) : !items.data?.length ? (
        <EmptyState title="No menu items" />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Item</Th>
              <Th>On the apps</Th>
              <Th className="text-right">Price</Th>
              <Th className="min-w-[220px]">Item id</Th>
            </tr>
          </THead>
          <tbody>
            {items.data.map((it) => (
              <tr key={it.menuItemId}>
                <Td>
                  <span className="block font-semibold">{it.name}</span>
                  <span className="block text-xs text-muted">{it.category}</span>
                </Td>
                <Td>{!it.published ? <Badge>Hidden</Badge> : it.available ? <Badge tone="success">Available</Badge> : <Badge tone="warning">Unavailable</Badge>}</Td>
                <Td className="tabular text-right">{it.price != null ? formatINR(it.price) : "—"}</Td>
                <Td>
                  <Input
                    aria-label={`${it.name} id on the apps`}
                    value={edits[it.menuItemId] ?? (it.custom ? it.externalId : "")}
                    placeholder={it.menuItemId}
                    onChange={(e) => setEdits((m) => ({ ...m, [it.menuItemId]: e.target.value }))}
                    onBlur={() => void saveId(it)}
                    maxLength={100}
                  />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

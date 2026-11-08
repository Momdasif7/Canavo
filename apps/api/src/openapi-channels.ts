import type { Op } from "./openapi";

/** Phase 6 (module CHANNELS): channel hub, Online orders board, QR table ordering, online ordering page. */
export const ops: Op[] = [
  // Settings → Channels (channel:manage)
  ["get", "/channels/connection", "The outlet's hub connection (secrets masked) + dead-lettered status pushes", "Channels"],
  ["put", "/channels/connection", "Create / update the connection; provider HUB | URBANPIPER. The hub URL must be https to a public host in production, never a metadata / link-local address. Body: channelConnectionSchema", "Channels"],
  ["post", "/channels/connection/test", "Ping the hub with the saved credentials → { ok, error? }", "Channels"],
  ["post", "/channels/connection/store", "Open / close the store on every channel. Body: { open }", "Channels"],
  ["post", "/channels/connection/menu-sync", "Push the menu now (hidden left out, out of stock → unavailable)", "Channels"],
  ["post", "/channels/connection/retry-failed", "Re-queue status pushes that gave up", "Channels"],
  ["get", "/channels/items", "Menu items with the id each is published under and channel availability", "Channels"],
  ["put", "/channels/items/{menuItemId}", "Set / clear (null) the channel's id for a menu item. Body: { externalId }", "Channels"],
  ["get", "/channels/orders", "Recent channel orders (accepted, rejected, cancelled) with our bill ?limit", "Channels"],
  ["post", "/channels/orders/{orderId}/status", "Push a status by hand (ACCEPTED, FOOD_READY, DISPATCHED, DELIVERED). Body: { status, reason? }", "Channels"],
  ["post", "/channels/hub/{connectionId}/webhook", "Hub webhook (public; HMAC x-hub-signature for HUB, x-canavo-webhook-secret for URBANPIPER): new order, cancellation, rider status", "Channels", false],
  // Online orders board (order:create | kot:view | channel:manage); socket event channel:board { orderId, stage }
  ["get", "/channels/board", "Today's (outlet time) channel + online orders, newest first, plus older ones not yet handed over → { orders: ChannelBoardOrder[] }", "Online orders board"],
  ["post", "/channels/board/{orderId}/packed", "Mark packed; pushes FOOD_READY once (shared with the KOT-ready hook). 409 if cancelled / handed over → ChannelBoardOrder", "Online orders board"],
  ["post", "/channels/board/{orderId}/handover", "Handed to the rider (or our partner); pushes DISPATCHED. Body: channelHandoverSchema { riderName? } → ChannelBoardOrder", "Online orders board"],
  ["get", "/channels/board/{orderId}/slip", "Packing slip / bag label data → ChannelPackingSlip (board order + outletName, printedAt, amountDue)", "Online orders board"],
  ["get", "/channels/board/{orderId}/print", "Bill + KOTs + packing slip as one plain-text print job ?paper=58|80 → { text } (marks KOTs printed)", "Online orders board"],
  ["get", "/channels/board/settings", "Auto-print on arrival → { autoPrint }", "Online orders board"],
  ["put", "/channels/board/settings", "Change auto-print (channel:manage). Body: channelBoardSettingsSchema", "Online orders board"],
  // Settings → Online ordering, QR / online requests (staff)
  ["get", "/storefront/settings", "QR ordering + online ordering page settings and public slug", "Storefront"],
  ["put", "/storefront/settings", "Update storefront settings. Body: storefrontUpdateSchema", "Storefront"],
  ["get", "/storefront/tables", "Active tables with their QR token", "Storefront"],
  ["post", "/storefront/tables/{id}/rotate", "New QR token for a table (old printed codes stop working)", "Storefront"],
  ["get", "/storefront/requests", "QR / online orders waiting for staff (and recent decisions)", "Storefront"],
  ["post", "/storefront/requests/{id}/accept", "Accept: send to the kitchen / confirm the online order", "Storefront"],
  ["post", "/storefront/requests/{id}/reject", "Reject (online: cancels the bill). Body: channelRejectSchema", "Storefront"],
  // Customers (no login)
  ["get", "/public/t/{token}", "QR table page: outlet, table and menu (a cinema seat adds theatre { seat, show, options, settings })", "Public ordering", false],
  ["post", "/public/t/{token}/orders", "Order from the table (joins the running tab). Body: qrOrderSchema; a cinema seat takes seatOrderSchema (timing) and always returns a UPI QR to prepay", "Public ordering", false],
  ["get", "/public/t/{token}/orders", "This table's orders and their status (seats: timing, pickupToken, runner stage, pending UPI)", "Public ordering", false],
  ["post", "/public/t/{token}/call", "Call a waiter / ask for the bill. Body: tableCallSchema", "Public ordering", false],
  ["get", "/public/o/{slug}", "Online ordering page: outlet, menu, takeaway / delivery options", "Public ordering", false],
  ["post", "/public/o/{slug}/orders", "Place an online order (takeaway / delivery, pay at counter, COD or UPI). Body: onlineOrderSchema → { token }", "Public ordering", false],
  ["get", "/public/o/{slug}/orders/{token}", "Order confirmation / status page", "Public ordering", false],
  ["post", "/public/o/{slug}/orders/{token}/upi", "A fresh UPI QR when the first expired", "Public ordering", false],
];

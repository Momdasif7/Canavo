import type { Op } from "./openapi";

const T = "Inventory";
const R = "Inventory reports";
const X = " — add ?format=xlsx for Excel";

export const ops: Op[] = [
  // Items
  ["get", "/inventory/items", "Items with outlet stock, value, low-stock flag ?search&category&lowStock=1&includeInactive=1", T],
  ["get", "/inventory/items/categories", "Item categories with counts", T],
  ["get", "/inventory/items/lookup", "Find item by barcode or SKU ?code= (USB/webcam scanners)", T],
  ["get", "/inventory/items/{id}", "Item detail: stock per outlet, recipes using it, last 50 transactions", T],
  ["post", "/inventory/items", "Create item (optional openingStock). Body: inventoryItemSchema", T],
  ["patch", "/inventory/items/{id}", "Update item. Body: inventoryItemUpdateSchema", T],
  ["delete", "/inventory/items/{id}", "Deactivate item", T],
  ["post", "/inventory/items/{id}/adjust", "Opening stock / manual adjustment (signed quantity or setTo). Body: stockAdjustSchema", T],
  ["get", "/inventory/transactions", "Stock ledger ?itemId&type&from&to&limit", T],
  // Recipes
  ["get", "/inventory/recipes", "Recipe lines ?menuItemId=", T],
  ["get", "/inventory/recipes/costing", "Ingredient cost vs selling price, food-cost %, margin per item/variant" + X, T],
  ["put", "/inventory/recipes/{menuItemId}", "Replace recipe for an item or variant. Body: recipeUpsertSchema", T],
  // Vendors
  ["get", "/inventory/vendors", "Vendors with spend summary ?search&includeInactive=1", T],
  ["get", "/inventory/vendors/{id}", "Vendor with spend summary and recent purchases", T],
  ["post", "/inventory/vendors", "Create vendor. Body: vendorSchema", T],
  ["patch", "/inventory/vendors/{id}", "Update vendor. Body: vendorUpdateSchema", T],
  ["delete", "/inventory/vendors/{id}", "Deactivate vendor", T],
  // Purchases
  ["get", "/inventory/purchases", "Purchases ?vendorId&status&from&to&unpaid=1&limit", T],
  ["get", "/inventory/purchases/{id}", "Purchase detail with lines and balance", T],
  ["post", "/inventory/purchases", "Create draft purchase (or receive:true). Body: purchaseCreateSchema", T],
  ["patch", "/inventory/purchases/{id}", "Update draft (received: invoice fields only). Body: purchaseUpdateSchema", T],
  ["post", "/inventory/purchases/{id}/receive", "Receive: add stock (PURCHASE) and update weighted-average cost", T],
  ["post", "/inventory/purchases/{id}/cancel", "Cancel; reverses stock as RETURN if received. Body: purchaseCancelSchema", T],
  ["post", "/inventory/purchases/{id}/payments", "Record payment to vendor. Body: purchasePaymentSchema", T],
  // Wastage
  ["post", "/inventory/wastage", "Record wastage. Body: wastageSchema", T],
  ["get", "/inventory/wastage", "Wastage entries ?from&to", T],
  // Audits
  ["get", "/inventory/audits", "Stock audits for outlet", T],
  ["get", "/inventory/audits/{id}", "Audit with lines, variances and variance value", T],
  ["post", "/inventory/audits", "Start audit (snapshots system qty). Body: stockAuditStartSchema", T],
  ["put", "/inventory/audits/{id}/counts", "Save physical counts (partial OK). Body: stockAuditCountsSchema", T],
  ["post", "/inventory/audits/{id}/complete", "Complete audit: post AUDIT adjustments for variances", T],
  ["post", "/inventory/audits/{id}/cancel", "Cancel in-progress audit", T],
  // Transfers
  ["get", "/inventory/transfers", "Transfers ?direction=incoming|outgoing|all&status", T],
  ["get", "/inventory/transfers/{id}", "Transfer detail", T],
  ["post", "/inventory/transfers", "Send to (toOutletId) or request from (fromOutletId) another outlet. Body: stockTransferCreateSchema", T],
  ["post", "/inventory/transfers/{id}/approve", "Approve (source manager / super admin)", T],
  ["post", "/inventory/transfers/{id}/reject", "Reject. Body: stockTransferRejectSchema", T],
  ["post", "/inventory/transfers/{id}/dispatch", "Dispatch: TRANSFER_OUT at source", T],
  ["post", "/inventory/transfers/{id}/receive", "Receive: TRANSFER_IN at destination", T],
  ["post", "/inventory/transfers/{id}/cancel", "Cancel requested/approved transfer", T],
  // Alerts & reports
  ["get", "/inventory/alerts", "Low-stock items for outlet with suggested order qty", T],
  ["get", "/inventory/reports/consumption", "Daily consumption per ingredient (sale/wastage) ?from&to&itemId" + X, R],
  ["get", "/inventory/reports/movement", "Opening, in, out, closing per item ?from&to&itemId" + X, R],
  ["get", "/inventory/reports/valuation", "Stock valuation (qty × weighted cost)" + X, R],
  ["get", "/inventory/reports/wastage", "Wastage detail and by item ?from&to&itemId" + X, R],
  ["get", "/inventory/reports/vendor-spend", "Spend, paid and outstanding per vendor ?from&to" + X, R],
  ["get", "/inventory/reports/purchases", "Purchase register ?from&to" + X, R],
];

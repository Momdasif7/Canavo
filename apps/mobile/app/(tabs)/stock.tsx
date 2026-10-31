import React from "react";
import { Screen } from "../../src/components/Screen";
import { StockScreen } from "../../src/inventory/StockScreen";
import { withAccess } from "../../src/auth/RequireAccess";

/** Stock tab for kitchen / inventory staff (others reach it from More → Inventory). */
function StockTab() {
  return (
    <Screen scroll={false}>
      <StockScreen />
    </Screen>
  );
}

export default withAccess(["inventory:view"], StockTab);

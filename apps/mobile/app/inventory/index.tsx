import React from "react";
import { Screen } from "../../src/components/Screen";
import { StockScreen } from "../../src/inventory/StockScreen";
import { withAccess } from "../../src/auth/RequireAccess";

function Inventory() {
  return (
    <Screen scroll={false} edges={[]}>
      <StockScreen />
    </Screen>
  );
}

export default withAccess(["inventory:view"], Inventory);

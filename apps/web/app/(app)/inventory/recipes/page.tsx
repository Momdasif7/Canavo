"use client";

import { useState } from "react";
import { useSession } from "@/components/providers/SessionProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { InventoryTabs } from "@/components/inventory/InventoryTabs";
import { RecipeEditor, type RecipeSelection } from "@/components/inventory/RecipeEditor";
import { RecipeCosting } from "@/components/inventory/RecipeCosting";

type Tab = "editor" | "costing";

export default function RecipesPage() {
  const { can } = useSession();
  // Food cost % and margins are profit data (owner / manager only).
  const showCosting = can("report:view");
  const [tab, setTab] = useState<Tab>("editor");
  const [selection, setSelection] = useState<RecipeSelection | null>(null);
  const [version, setVersion] = useState(0);

  return (
    <PageContainer>
      <PageHeader
        title="Recipes"
        subtitle="Ingredients per portion — stock is deducted automatically when items are billed"
        actions={
          showCosting && (
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: "editor", label: "Recipe editor" },
              { value: "costing", label: "Costing" },
            ]}
          />
          )
        }
      />
      <InventoryTabs />
      {tab === "editor" || !showCosting ? (
        <RecipeEditor selection={selection} onSelect={setSelection} onSaved={() => setVersion((v) => v + 1)} />
      ) : (
        <RecipeCosting
          version={version}
          onOpen={(row) => {
            setSelection({ menuItemId: row.menuItemId, variantId: row.variantId });
            setTab("editor");
          }}
        />
      )}
    </PageContainer>
  );
}

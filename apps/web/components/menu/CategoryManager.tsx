"use client";

import { useState } from "react";
import clsx from "clsx";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { categorySchema } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { MenuCategory, MenuItem } from "@/lib/types";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

interface Editing {
  id?: string;
  name: string;
  parentId: string;
  sortOrder: string;
}

export function CategoryManager({
  categories,
  items,
  selected,
  onSelect,
  onChanged,
}: {
  categories: MenuCategory[];
  items: MenuItem[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parents = categories.filter((c) => !c.parentId);
  const count = (id: string) => items.filter((i) => i.categoryId === id).length;

  const save = async () => {
    if (!editing) return;
    const parsed = categorySchema.safeParse({
      name: editing.name.trim(),
      parentId: editing.parentId || null,
      sortOrder: Number(editing.sortOrder) || 0,
    });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    setSaving(true);
    setError(null);
    try {
      if (editing.id) await api.patch(`/menu/categories/${editing.id}`, parsed.data);
      else await api.post("/menu/categories", parsed.data);
      setEditing(null);
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: MenuCategory) => {
    if (!window.confirm(`Delete category “${c.name}”?`)) return;
    try {
      await api.del(`/menu/categories/${c.id}`);
      if (selected === c.id) onSelect(null);
      toast("Category deleted", "success");
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const row = (c: MenuCategory, depth: number) => (
    <li key={c.id}>
      <div
        className={clsx(
          "group flex min-h-tap items-center gap-1 rounded-xl pr-1",
          selected === c.id ? "bg-primary-50 text-primary-700 dark:bg-primary/15 dark:text-primary-200" : "hover:bg-surface-2",
        )}
      >
        <button type="button" onClick={() => onSelect(c.id)} className={clsx("flex min-h-tap flex-1 items-center justify-between gap-2 text-left font-semibold", depth ? "pl-8" : "pl-3")}>
          <span className="truncate">{c.name}</span>
          <span className="text-xs font-normal text-muted">{count(c.id)}</span>
        </button>
        <IconButton label={`Edit ${c.name}`} className="min-h-[40px] min-w-[40px]" onClick={() => setEditing({ id: c.id, name: c.name, parentId: c.parentId ?? "", sortOrder: String(c.sortOrder) })}>
          <PencilSimple size={18} />
        </IconButton>
        <IconButton label={`Delete ${c.name}`} className="min-h-[40px] min-w-[40px] text-red-600" onClick={() => remove(c)}>
          <Trash size={18} />
        </IconButton>
      </div>
    </li>
  );

  return (
    <Card>
      <CardHeader
        title="Categories"
        action={
          <Button size="sm" variant="outline" icon={<Plus size={16} />} onClick={() => setEditing({ name: "", parentId: "", sortOrder: "0" })}>
            Add
          </Button>
        }
      />
      <ul className="space-y-0.5 p-2">
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={clsx(
              "flex min-h-tap w-full items-center justify-between rounded-xl px-3 font-semibold",
              selected === null ? "bg-primary-50 text-primary-700 dark:bg-primary/15 dark:text-primary-200" : "hover:bg-surface-2",
            )}
          >
            All items <span className="text-xs font-normal text-muted">{items.length}</span>
          </button>
        </li>
        {parents.map((p) => [row(p, 0), ...categories.filter((c) => c.parentId === p.id).map((c) => row(c, 1))])}
      </ul>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        size="sm"
        title={editing?.id ? "Edit category" : "New category"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              Save
            </Button>
          </>
        }
      >
        {editing && (
          <div className="space-y-4">
            {error && <Alert>{error}</Alert>}
            <Input label="Name" maxLength={60} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            <Select label="Parent category" value={editing.parentId} onChange={(e) => setEditing({ ...editing, parentId: e.target.value })} hint="Leave empty for a top-level category">
              <option value="">— None (top level) —</option>
              {parents
                .filter((p) => p.id !== editing.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
            <Input label="Sort order" type="number" value={editing.sortOrder} onChange={(e) => setEditing({ ...editing, sortOrder: e.target.value })} />
          </div>
        )}
      </Dialog>
    </Card>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { FloppyDisk, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import type { DiningTable, FloorArea, FloorTable, TableShape } from "@/lib/types-service";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Alert } from "@/components/ui/States";
import { FloorCanvas, type TableBox } from "./FloorCanvas";

const SHAPES: { value: TableShape; label: string }[] = [
  { value: "SQUARE", label: "Square" },
  { value: "ROUND", label: "Round" },
  { value: "RECTANGLE", label: "Rect" },
];

/** First free 2×2 spot in the area (left-to-right, top-to-bottom). */
function freeSpot(tables: TableBox[]): { posX: number; posY: number } {
  for (let y = 1; y < 60; y += 3) {
    for (let x = 1; x < 24; x += 3) {
      const clash = tables.some((t) => x < t.posX + t.width && x + 2 > t.posX && y < t.posY + t.height && y + 2 > t.posY);
      if (!clash) return { posX: x, posY: y };
    }
  }
  return { posX: 1, posY: 1 };
}

/**
 * Floor editor (table:manage): drag to move (snaps to grid), corner handle to
 * resize, edit/add/delete tables and areas. Positions are saved in one go via
 * PUT /tables/layout; table properties save immediately.
 */
export function FloorEditor({
  areas,
  area,
  now,
  onAreaChange,
  onReload,
  onDone,
}: {
  areas: FloorArea[];
  area: FloorArea;
  now: number;
  onAreaChange: (id: string | null) => void;
  onReload: () => Promise<void>;
  onDone: () => void;
}) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<Map<string, TableBox>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [areaDialog, setAreaDialog] = useState<null | "new" | "rename">(null);
  const [deleting, setDeleting] = useState<null | "table" | "area">(null);
  const realAreas = areas.filter((a): a is FloorArea & { id: string } => a.id !== null);
  const allTables = useMemo(() => areas.flatMap((a) => a.tables), [areas]);
  const selected = allTables.find((t) => t.id === selectedId) ?? null;

  useEffect(() => setSelectedId(null), [area.id]);

  const changed = [...drafts.entries()].filter(([id, b]) => {
    const t = allTables.find((x) => x.id === id);
    return t && (t.posX !== b.posX || t.posY !== b.posY || t.width !== b.width || t.height !== b.height || t.shape !== b.shape);
  });

  const saveLayout = async () => {
    if (!changed.length) return onDone();
    setSaving(true);
    try {
      await api.put<DiningTable[]>("/tables/layout", { tables: changed.map(([id, b]) => ({ id, ...b, rotation: allTables.find((t) => t.id === id)?.rotation ?? 0 })) });
      setDrafts(new Map());
      await onReload();
      toast(`Layout saved (${changed.length} table${changed.length === 1 ? "" : "s"})`, "success");
      onDone();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const addTable = async () => {
    const boxes = area.tables.map((t) => drafts.get(t.id) ?? t);
    const existing = new Set(allTables.map((t) => t.label));
    let n = allTables.length + 1;
    while (existing.has(`T${n}`)) n++;
    try {
      const t = await api.post<DiningTable>("/tables", { label: `T${n}`, areaId: area.id, capacity: 4, shape: "SQUARE", width: 2, height: 2, rotation: 0, active: true, ...freeSpot(boxes) });
      await onReload();
      setSelectedId(t.id);
      toast(`Table ${t.label} added`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary-50 px-3 py-2 text-sm dark:bg-primary/10">
          <strong className="mr-1">Editing floor</strong>
          <span className="text-muted">Drag to move · corner to resize · tap to edit</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" icon={<Plus size={18} />} onClick={() => void addTable()} disabled={area.id === null && realAreas.length > 0}>
              Add table
            </Button>
            <Button size="sm" variant="outline" icon={<Plus size={18} />} onClick={() => setAreaDialog("new")}>
              Add area
            </Button>
            {area.id && (
              <>
                <Button size="sm" variant="outline" icon={<PencilSimple size={18} />} onClick={() => setAreaDialog("rename")}>
                  Rename area
                </Button>
                <Button size="sm" variant="outline" icon={<Trash size={18} />} onClick={() => setDeleting("area")}>
                  Delete area
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={18} />}
              onClick={() => {
                setDrafts(new Map());
                onDone();
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="secondary" icon={<FloppyDisk size={18} />} loading={saving} onClick={saveLayout}>
              {changed.length ? `Save layout (${changed.length})` : "Done"}
            </Button>
          </div>
        </div>
        <FloorCanvas
          tables={area.tables}
          boxes={drafts}
          editable
          now={now}
          selectedId={selectedId}
          onSelect={(t) => setSelectedId(t.id)}
          onBoxChange={(id, b) => setDrafts((m) => new Map(m).set(id, b))}
        />
      </div>

      <Card className="w-full shrink-0 p-4 lg:w-72">
        {selected ? (
          <TableForm
            key={selected.id}
            table={selected}
            areas={realAreas}
            box={drafts.get(selected.id) ?? selected}
            onShape={(shape) => setDrafts((m) => new Map(m).set(selected.id, { ...(m.get(selected.id) ?? selected), shape }))}
            onSaved={async (areaId) => {
              await onReload();
              if (areaId !== area.id) onAreaChange(areaId);
            }}
            onDelete={() => setDeleting("table")}
          />
        ) : (
          <p className="text-sm text-muted">Select a table to edit its label, seats, shape or area.</p>
        )}
      </Card>

      <AreaDialog
        mode={areaDialog}
        area={area}
        onClose={() => setAreaDialog(null)}
        onSaved={async (id) => {
          setAreaDialog(null);
          await onReload();
          onAreaChange(id);
        }}
      />
      <ConfirmDialog
        open={deleting === "table"}
        title={`Delete table ${selected?.label ?? ""}?`}
        description="Tables with past tabs or reservations are deactivated instead, so history stays intact."
        confirmLabel="Delete table"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!selected) return;
          try {
            await api.del(`/tables/${selected.id}`);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          setSelectedId(null);
          await onReload();
          toast("Table removed", "success");
        }}
      />
      <ConfirmDialog
        open={deleting === "area"}
        title={`Delete area “${area.name}”?`}
        description="Its tables stay and move to “Unassigned”."
        confirmLabel="Delete area"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await api.del(`/tables/areas/${area.id}`);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          await onReload();
          onAreaChange(null);
          toast("Area deleted", "success");
        }}
      />
    </div>
  );
}

function TableForm({
  table,
  areas,
  box,
  onShape,
  onSaved,
  onDelete,
}: {
  table: FloorTable;
  areas: { id: string; name: string }[];
  box: TableBox;
  onShape: (s: TableShape) => void;
  onSaved: (areaId: string | null) => Promise<void>;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState(table.label);
  const [capacity, setCapacity] = useState(String(table.capacity));
  const [areaId, setAreaId] = useState(table.areaId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/tables/${table.id}`, {
        label: label.trim(),
        capacity: Math.max(1, Math.min(50, Math.floor(Number(capacity) || 1))),
        areaId: areaId || null,
        shape: box.shape,
      });
      toast(`Table ${label.trim()} saved`, "success");
      await onSaved(areaId || null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="font-bold">Table {table.label}</h3>
      {error && <Alert>{error}</Alert>}
      <Input label="Label" value={label} maxLength={20} onChange={(e) => setLabel(e.target.value)} />
      <Input label="Seats" type="number" min={1} max={50} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
      <div>
        <p className="mb-1.5 text-sm font-semibold">Shape</p>
        <Segmented size="sm" className="w-full" value={box.shape} onChange={onShape} options={SHAPES} />
      </div>
      <Select label="Area" value={areaId} onChange={(e) => setAreaId(e.target.value)}>
        <option value="">Unassigned</option>
        {areas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <p className="text-xs text-muted">
        Position {box.posX},{box.posY} · size {box.width}×{box.height}
      </p>
      <div className="flex gap-2">
        <Button variant="danger" size="sm" icon={<Trash size={16} />} onClick={onDelete} disabled={!!table.session}>
          Delete
        </Button>
        <Button size="sm" className="flex-1" onClick={save} loading={busy} disabled={!label.trim()}>
          Save table
        </Button>
      </div>
      {table.session && <p className="text-xs text-muted">Has an open tab — close it before deleting.</p>}
    </div>
  );
}

function AreaDialog({ mode, area, onClose, onSaved }: { mode: null | "new" | "rename"; area: FloorArea; onClose: () => void; onSaved: (id: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(mode === "rename" ? area.name : "");
    setError(null);
  }, [mode, area.name]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "rename" && area.id
          ? await api.patch<{ id: string }>(`/tables/areas/${area.id}`, { name: name.trim() })
          : await api.post<{ id: string }>("/tables/areas", { name: name.trim(), sortOrder: 0 });
      await onSaved(res.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!mode}
      onClose={onClose}
      size="sm"
      title={mode === "rename" ? "Rename area" : "New area"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <Input label="Area name" placeholder="e.g. Terrace" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && void submit()} />
    </Dialog>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, Card, Chip, ErrorState, Input, Loading, Notice, Row } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { kvGet, kvSet } from "../../src/lib/db";
import { formatDate, inr } from "../../src/lib/format";
import type { StockAudit, StockAuditLine } from "../../src/lib/types";
import { BarcodeScanner } from "../../src/inventory/BarcodeScanner";
import { fmtQty } from "../../src/inventory/StockActionSheet";
import { font, radius, space, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

type Filter = "ALL" | "TODO" | "VARIANCE";
const AUTOSAVE_MS = 45_000;
const draftKey = (id: string) => `auditDraft:${id}`;

function parseQty(text: string): number | null {
  if (text.trim() === "") return null;
  const n = Number(text.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Physical stock count. Big numeric inputs, "next" on the keyboard jumps to
 * the next item, barcode scan jumps to that item. Unsaved counts are kept on
 * the phone (SQLite) so a crash or call doesn't lose them; Save sends only
 * changed lines; Complete posts the variances as AUDIT adjustments.
 */
function StockCount() {
  const t = useTheme();
  const [audit, setAudit] = useState<StockAudit | null>(null);
  const [phase, setPhase] = useState<"loading" | "start" | "counting" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<{ category: string; count: number }[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("ALL");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<null | "start" | "save" | "complete">(null);
  const [message, setMessage] = useState<{ kind: "success" | "error" | "warning"; text: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const inputs = useRef(new Map<string, TextInput | null>());
  const listRef = useRef<FlatList<StockAuditLine>>(null);

  const applyAudit = useCallback(async (a: StockAudit) => {
    setAudit(a);
    const saved = Object.fromEntries(a.lines.map((l) => [l.inventoryItemId, l.countedQty == null ? "" : fmtQty(l.countedQty)]));
    const local = await kvGet<Record<string, string>>(draftKey(a.id));
    const merged = { ...saved, ...(local?.value ?? {}) };
    setDrafts(merged);
    setDirty(new Set(Object.keys(local?.value ?? {}).filter((k) => local!.value[k] !== saved[k])));
    setPhase("counting");
  }, []);

  const load = useCallback(async () => {
    setPhase("loading");
    try {
      const list = await endpoints.audits();
      const open = list.find((a) => a.status === "IN_PROGRESS");
      if (open) await applyAudit(await endpoints.audit(open.id));
      else {
        setCategories(await endpoints.inventoryCategories());
        setPhase("start");
      }
    } catch (e) {
      setError(errorMessage(e));
      setPhase("error");
    }
  }, [applyAudit]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep unsaved counts on the phone.
  useEffect(() => {
    if (!audit || !dirty.size) return;
    const pending = Object.fromEntries([...dirty].map((id) => [id, drafts[id] ?? ""]));
    const timer = setTimeout(() => void kvSet(draftKey(audit.id), pending), 400);
    return () => clearTimeout(timer);
  }, [audit, drafts, dirty]);

  const save = useCallback(
    async (quiet = false): Promise<StockAudit | null> => {
      if (!audit) return null;
      if (!dirty.size) return audit;
      const counts = [...dirty].map((id) => ({ inventoryItemId: id, countedQty: parseQty(drafts[id] ?? "") }));
      if (!quiet) setBusy("save");
      try {
        const next = await endpoints.saveAuditCounts(audit.id, counts);
        setAudit(next);
        setDirty(new Set());
        await kvSet(draftKey(audit.id), {});
        if (!quiet) setMessage({ kind: "success", text: `Saved ${counts.length} count${counts.length === 1 ? "" : "s"}.` });
        return next;
      } catch (e) {
        if (!quiet) setMessage({ kind: "error", text: errorMessage(e) });
        return null;
      } finally {
        if (!quiet) setBusy(null);
      }
    },
    [audit, dirty, drafts],
  );

  useEffect(() => {
    if (phase !== "counting") return;
    const timer = setInterval(() => void save(true), AUTOSAVE_MS);
    return () => clearInterval(timer);
  }, [phase, save]);

  const start = async () => {
    setBusy("start");
    setMessage(null);
    try {
      await applyAudit(await endpoints.startAudit(category ? { category } : {}));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setMessage({ kind: "error", text: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const lines = audit?.lines ?? [];
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      const counted = parseQty(drafts[l.inventoryItemId] ?? "");
      if (filter === "TODO" && counted != null) return false;
      if (filter === "VARIANCE" && (counted == null || Math.abs(counted - l.systemQty) < 1e-9)) return false;
      return !q || l.item.name.toLowerCase().includes(q) || l.item.category.toLowerCase().includes(q);
    });
  }, [lines, drafts, filter, query]);

  const countedLocal = lines.filter((l) => parseQty(drafts[l.inventoryItemId] ?? "") != null).length;
  /** Paise value of the variance so far (counted − system) × cost. */
  const varianceLocal = lines.reduce((sum, l) => {
    const c = parseQty(drafts[l.inventoryItemId] ?? "");
    return c == null ? sum : sum + (c - l.systemQty) * l.item.costPerUnit;
  }, 0);

  // Scroll to and focus an item (after a scan or "next").
  useEffect(() => {
    if (!focusId) return;
    const idx = visible.findIndex((l) => l.inventoryItemId === focusId);
    if (idx < 0) return;
    listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
    const timer = setTimeout(() => {
      inputs.current.get(focusId)?.focus();
      setFocusId(null);
    }, 350);
    return () => clearTimeout(timer);
  }, [focusId, visible]);

  const complete = () => {
    if (!audit) return;
    Alert.alert(
      "Complete stock count?",
      `${countedLocal} of ${lines.length} items counted. Stock will be adjusted to your counts (uncounted items are left as they are). This can't be undone.`,
      [
        { text: "Keep counting", style: "cancel" },
        {
          text: "Complete",
          style: "destructive",
          onPress: async () => {
            setBusy("complete");
            setMessage(null);
            try {
              const saved = await save(true);
              if (!saved) throw new Error("Could not save the latest counts — check your connection.");
              const done = await endpoints.completeAudit(audit.id);
              await kvSet(draftKey(audit.id), {});
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              Alert.alert(
                "Stock count completed",
                `${done.summary.counted} counted · ${done.summary.withVariance} with variance · variance value ${inr(done.summary.varianceValue)}`,
                [{ text: "OK", onPress: () => router.back() }],
              );
            } catch (e) {
              setMessage({ kind: "error", text: errorMessage(e) });
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  };

  const onScan = (code: string) => {
    const line = lines.find((l) => l.item.barcode === code || l.item.sku?.toUpperCase() === code.toUpperCase());
    if (!line) {
      setMessage({ kind: "warning", text: `“${code}” is not part of this count.` });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setScanning(false);
    setFilter("ALL");
    setQuery("");
    setFocusId(line.inventoryItemId);
  };

  if (phase === "loading") return <Screen edges={[]} scroll={false}><Loading label="Loading stock count…" /></Screen>;
  if (phase === "error") return <Screen edges={[]} scroll={false}><ErrorState message={error ?? "Failed"} onRetry={load} /></Screen>;

  if (phase === "start" || !audit) {
    return (
      <Screen edges={[]}>
        <Card style={{ gap: space.md }}>
          <AppText variant="h2">Start a stock count</AppText>
          <AppText variant="muted">
            The system quantity of every item is snapshotted now. Count what's on the shelves; sales during the count are handled automatically.
          </AppText>
          {categories.length ? (
            <View style={{ gap: space.sm }}>
              <AppText variant="small">Count only one category (optional)</AppText>
              <Row style={{ flexWrap: "wrap" }}>
                <Chip label="Everything" selected={!category} onPress={() => setCategory(null)} />
                {categories.map((c) => (
                  <Chip key={c.category} label={`${c.category} (${c.count})`} selected={category === c.category} onPress={() => setCategory(c.category)} />
                ))}
              </Row>
            </View>
          ) : null}
          {message ? <Notice kind={message.kind} message={message.text} /> : null}
          <Button title="Start counting" icon="clipboard-outline" size="xl" loading={busy === "start"} onPress={start} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen edges={["bottom"]} scroll={false}>
      <View style={{ padding: space.md, gap: space.sm }}>
        <Row style={{ justifyContent: "space-between" }}>
          <View>
            <AppText variant="h3">Count started {formatDate(audit.createdAt)}</AppText>
            <AppText variant="small">
              {countedLocal}/{lines.length} counted{dirty.size ? ` · ${dirty.size} unsaved` : " · all saved"}
              {varianceLocal ? ` · variance ≈ ${inr(Math.round(varianceLocal))}` : ""}
            </AppText>
          </View>
          <Button title="Scan" icon="barcode-outline" size="md" variant="secondary" onPress={() => setScanning(true)} />
        </Row>
        <View style={[styles.progress, { backgroundColor: t.surfaceAlt }]}>
          <View style={{ width: `${lines.length ? Math.round((countedLocal / lines.length) * 100) : 0}%`, backgroundColor: t.success, height: "100%", borderRadius: radius.pill }} />
        </View>
        <Input placeholder="Find item" value={query} onChangeText={setQuery} style={{ minHeight: 46 }} />
        <Row>
          <Chip label="All" selected={filter === "ALL"} onPress={() => setFilter("ALL")} />
          <Chip label={`To count (${lines.length - countedLocal})`} selected={filter === "TODO"} onPress={() => setFilter("TODO")} />
          <Chip label="Variance" selected={filter === "VARIANCE"} onPress={() => setFilter("VARIANCE")} />
        </Row>
        {message ? (
          <Pressable onPress={() => setMessage(null)}>
            <Notice kind={message.kind} message={message.text} />
          </Pressable>
        ) : null}
      </View>
      <FlatList
        ref={listRef}
        data={visible}
        keyExtractor={(l) => l.inventoryItemId}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: space.md, gap: space.sm, paddingBottom: 160 }}
        onScrollToIndexFailed={(info) => listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true })}
        renderItem={({ item: l, index }) => {
          const text = drafts[l.inventoryItemId] ?? "";
          const counted = parseQty(text);
          const variance = counted == null ? null : Math.round((counted - l.systemQty) * 1000) / 1000;
          const vColor = variance == null || variance === 0 ? t.textMuted : variance < 0 ? t.danger : t.success;
          return (
            <View style={[styles.line, { backgroundColor: t.surface, borderColor: counted != null ? t.success : t.border }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <AppText style={{ fontWeight: "800", fontSize: font.lg }} numberOfLines={2}>
                  {l.item.name}
                </AppText>
                <AppText variant="small">
                  {l.item.category} · system {fmtQty(l.systemQty)} {l.item.unit}
                </AppText>
                {variance != null ? (
                  <AppText style={{ fontWeight: "800" }} color={vColor}>
                    {variance === 0 ? "Matches" : `${variance > 0 ? "+" : ""}${fmtQty(variance)} ${l.item.unit}`}
                  </AppText>
                ) : null}
              </View>
              <TextInput
                ref={(r) => {
                  inputs.current.set(l.inventoryItemId, r);
                }}
                value={text}
                onChangeText={(v) => {
                  const clean = v.replace(/[^\d.,]/g, "");
                  setDrafts((d) => ({ ...d, [l.inventoryItemId]: clean }));
                  setDirty((d) => new Set(d).add(l.inventoryItemId));
                }}
                keyboardType="decimal-pad"
                returnKeyType={index < visible.length - 1 ? "next" : "done"}
                blurOnSubmit={index >= visible.length - 1}
                onSubmitEditing={() => {
                  const next = visible[index + 1];
                  if (next) setFocusId(next.inventoryItemId);
                }}
                placeholder="—"
                placeholderTextColor={t.textMuted}
                selectTextOnFocus
                accessibilityLabel={`Counted quantity of ${l.item.name} in ${l.item.unit}`}
                style={[styles.qty, { color: t.text, borderColor: counted != null ? t.success : t.border, backgroundColor: t.bg }]}
              />
              <AppText variant="small" style={{ width: 44 }}>
                {l.item.unit}
              </AppText>
            </View>
          );
        }}
      />
      <View style={[styles.footer, { backgroundColor: t.bg, borderColor: t.border }]}>
        <Button title={dirty.size ? `Save (${dirty.size})` : "Saved"} icon="save-outline" variant="secondary" style={{ flex: 1 }} disabled={!dirty.size} loading={busy === "save"} onPress={() => void save()} />
        <Button title="Complete" icon="checkmark-done" variant="success" style={{ flex: 1 }} disabled={!countedLocal} loading={busy === "complete"} onPress={complete} />
      </View>
      <BarcodeScanner visible={scanning} onClose={() => setScanning(false)} onCode={onScan} title="Scan to count" />
      {busy === "complete" ? (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.25)", justifyContent: "center" }]}>
          <Loading label="Completing…" />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  progress: { height: 8, borderRadius: radius.pill, overflow: "hidden" },
  line: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1.5, borderRadius: radius.md, padding: space.md },
  qty: { width: 110, minHeight: 60, borderWidth: 2, borderRadius: radius.md, fontSize: 26, fontWeight: "800", textAlign: "center", fontVariant: ["tabular-nums"] },
  footer: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", gap: space.sm, padding: space.md, borderTopWidth: 1 },
});

export default withAccess(["inventory:view"], StockCount);

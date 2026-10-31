import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { useNavigation } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { ROLE_LABELS } from "@canavo/shared";
import { withAccess } from "../src/auth/RequireAccess";
import { OfflineBanner } from "../src/components/Screen";
import { AppText, Button, Card, EmptyState, ErrorState, FeatureOff, Input, Loading, Notice, Row } from "../src/components/ui";
import { endpoints, errorMessage, isFeatureOff } from "../src/lib/api";
import type { AttendanceRegister, AttendanceRegisterRow, ManualStatus, RegisterRecord } from "../src/lib/types";
import { font, radius, space, TAP, useTheme } from "../src/theme";
import {
  changedEntries,
  describeRecord,
  displayTime,
  draftError,
  initialDrafts,
  isChanged,
  isOvernight,
  markAllPresent,
  needsTimes,
  shiftDate,
  shiftTimes,
  STATUS_LABEL,
  summarize,
  withStatus,
  type Drafts,
  type RowDraft,
  type SummaryKey,
} from "../src/attendance/register";
import { RecordSheet } from "../src/attendance/RecordSheet";
import { StatusButtons, statusColors } from "../src/attendance/StatusButtons";
import { TimeField } from "../src/attendance/TimeField";

const LEAVE_LABEL: Record<string, string> = { CASUAL: "Casual", SICK: "Sick", HALF_DAY: "Half-day", UNPAID: "Unpaid" };

function dateTitle(date: string, today: string | null) {
  if (date === today) return "Today";
  if (today && date === shiftDate(today, -1)) return "Yesterday";
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// ---------- One employee ----------
const EmployeeCard = memo(function EmployeeCard({
  row,
  draft,
  changed,
  onDraft,
  onEdit,
}: {
  row: AttendanceRegisterRow;
  draft: RowDraft;
  changed: boolean;
  onDraft: (userId: string, d: RowDraft) => void;
  onEdit: (row: AttendanceRegisterRow, record: RegisterRecord) => void;
}) {
  const t = useTheme();
  const colors = statusColors(t);
  const [noteOpen, setNoteOpen] = useState(!!draft.note);
  const shift = shiftTimes(row);
  const set = (patch: Partial<RowDraft>) => onDraft(row.user.id, { ...draft, ...patch });
  const pick = (s: ManualStatus) => onDraft(row.user.id, withStatus(row, draft, s));
  const err = changed ? draftError(draft) : null;
  const shown = draft.status ?? row.status;
  const first = row.records[0];

  return (
    <Pressable
      onLongPress={first && row.canMark ? () => onEdit(row, first) : undefined}
      delayLongPress={350}
      accessibilityHint={first && row.canMark ? "Long-press to edit the saved record" : undefined}
    >
      <Card style={[{ gap: space.md }, changed ? { borderColor: t.primary, borderWidth: 2 } : null]}>
        <Row style={{ alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <AppText variant="h3">{row.user.name}</AppText>
            <AppText variant="small">
              {ROLE_LABELS[row.user.role]}
              {row.user.shift
                ? ` · ${row.user.shift.name} ${displayTime(row.user.shift.startTime)}–${displayTime(row.user.shift.endTime)}`
                : " · No shift"}
              {row.user.status !== "ACTIVE" ? ` · ${row.user.status.toLowerCase()}` : ""}
            </AppText>
          </View>
          {changed ? (
            <View style={[styles.tag, { backgroundColor: t.warningBg }]}>
              <AppText style={{ color: t.warning, fontWeight: "800", fontSize: 12 }}>Unsaved</AppText>
            </View>
          ) : null}
          {!row.canMark ? (
            <View style={[styles.tag, { backgroundColor: t.surfaceAlt }]}>
              <Ionicons name="lock-closed" size={12} color={t.textMuted} />
              <AppText style={{ color: t.textMuted, fontWeight: "700", fontSize: 12 }}>View only</AppText>
            </View>
          ) : null}
        </Row>

        {row.leave ? (
          <Row style={[styles.info, { backgroundColor: t.surfaceAlt }]}>
            <Ionicons name="airplane-outline" size={16} color={t.info} />
            <AppText variant="small" style={{ flex: 1 }} color={t.text}>
              Approved {LEAVE_LABEL[row.leave.type] ?? ""} leave{row.leave.reason ? ` · ${row.leave.reason}` : ""}
            </AppText>
          </Row>
        ) : null}

        {row.records.map((r) => (
          <Row key={r.id} style={[styles.info, { backgroundColor: t.surfaceAlt }]}>
            <Ionicons name={r.source === "SELF" ? "location-outline" : "create-outline"} size={16} color={t.textMuted} />
            <AppText variant="small" style={{ flex: 1 }} color={t.text}>
              {describeRecord(r)}
              {r.note ? ` · “${r.note}”` : ""}
            </AppText>
            {row.canMark ? (
              <Pressable
                onPress={() => onEdit(row, r)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={`Edit or delete ${row.user.name}'s record`}
                style={styles.more}
              >
                <Ionicons name="ellipsis-horizontal" size={22} color={t.text} />
              </Pressable>
            ) : null}
          </Row>
        ))}

        {row.canMark ? (
          <>
            <StatusButtons value={draft.status} onChange={pick} name={row.user.name} />
            {needsTimes(draft.status) ? (
              <Row style={{ alignItems: "flex-start" }}>
                <TimeField label="In" value={draft.clockIn} onChange={(v) => set({ clockIn: v })} fallback={shift.startTime} />
                <TimeField
                  label="Out"
                  value={draft.clockOut}
                  onChange={(v) => set({ clockOut: v })}
                  fallback={shift.endTime}
                  placeholder="Not out"
                  clearable
                  hint={isOvernight(draft.clockIn, draft.clockOut) ? "Next day" : undefined}
                />
              </Row>
            ) : null}
            {noteOpen ? (
              <Input value={draft.note} onChangeText={(v) => set({ note: v })} placeholder="Note (optional)" maxLength={300} />
            ) : draft.status ? (
              <Pressable onPress={() => setNoteOpen(true)} accessibilityRole="button" style={styles.addNote}>
                <Ionicons name="add" size={18} color={t.primary} />
                <AppText color={t.primary} style={{ fontWeight: "700" }}>Add note</AppText>
              </Pressable>
            ) : null}
            {err ? <AppText variant="small" color={t.danger}>{err}</AppText> : null}
          </>
        ) : (
          <Row>
            {shown ? (
              <View style={[styles.badge, { backgroundColor: colors[shown].bg }]}>
                <AppText style={{ color: "#fff", fontWeight: "800" }}>{STATUS_LABEL[shown]}</AppText>
              </View>
            ) : (
              <AppText variant="muted">Not marked</AppText>
            )}
          </Row>
        )}
      </Card>
    </Pressable>
  );
});

// ---------- Screen ----------
function StaffAttendance() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const [today, setToday] = useState<string | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [reg, setReg] = useState<AttendanceRegister | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  /** Rows the user edited by hand (approved-leave preselection doesn't count as unsaved). */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ kind: "success" | "warning"; message: string } | null>(null);
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([]);
  const [editing, setEditing] = useState<{ row: AttendanceRegisterRow; record: RegisterRecord } | null>(null);

  const load = useCallback(async (d: string | null, keep?: Drafts) => {
    setError(null);
    try {
      const r = await endpoints.attendanceRegister(d ?? undefined);
      if (!d) setToday(r.date);
      setDate(r.date);
      setReg(r);
      const fresh = initialDrafts(r);
      setDrafts(keep ? { ...fresh, ...Object.fromEntries(Object.entries(keep).filter(([id]) => id in fresh)) } : fresh);
      setTouched(new Set(keep ? Object.keys(keep).filter((id) => id in fresh) : []));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const rowsById = useMemo(() => Object.fromEntries((reg?.staff ?? []).map((r) => [r.user.id, r])), [reg]);
  const entries = useMemo(() => (reg ? changedEntries(reg, drafts) : []), [reg, drafts]);
  const dirtyIds = useMemo(
    () => [...touched].filter((id) => rowsById[id] && drafts[id] && isChanged(rowsById[id], drafts[id])),
    [touched, rowsById, drafts],
  );
  const dirty = dirtyIds.length > 0;
  const summary = useMemo(() => (reg ? summarize(reg, drafts) : null), [reg, drafts]);
  const unmarked = useMemo(() => (reg ? reg.staff.filter((r) => r.canMark && !drafts[r.user.id]?.status).length : 0), [reg, drafts]);

  // Unsaved-changes prompt when leaving the screen.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    return navigation.addListener("beforeRemove", (e) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      Alert.alert("Discard unsaved attendance?", "You've marked attendance that isn't saved yet.", [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(e.data.action) },
      ]);
    });
  }, [navigation]);

  const confirmDiscard = (go: () => void) => {
    if (!dirty) return go();
    Alert.alert("Discard unsaved attendance?", `${dirtyIds.length} employee(s) have changes that aren't saved.`, [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: go },
    ]);
  };

  const goTo = (d: string) =>
    confirmDiscard(() => {
      void Haptics.selectionAsync();
      setResult(null);
      setSkipped([]);
      setLoading(true);
      void load(d);
    });

  const onDraft = useCallback((userId: string, d: RowDraft) => {
    setDrafts((prev) => ({ ...prev, [userId]: d }));
    setTouched((prev) => (prev.has(userId) ? prev : new Set(prev).add(userId)));
  }, []);

  const onEdit = useCallback((row: AttendanceRegisterRow, record: RegisterRecord) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setEditing({ row, record });
  }, []);

  const doMarkAll = () => {
    if (!reg) return;
    const { drafts: next, count } = markAllPresent(reg, drafts);
    if (!count) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setDrafts(next);
    setTouched((prev) => {
      const s = new Set(prev);
      for (const id of Object.keys(next)) if (next[id] !== drafts[id]) s.add(id);
      return s;
    });
  };

  const save = async () => {
    if (!reg || !date || !entries.length) return;
    const bad = reg.staff.find((r) => isChanged(r, drafts[r.user.id]) && draftError(drafts[r.user.id]));
    if (bad) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setResult({ kind: "warning", message: `${bad.user.name}: ${draftError(drafts[bad.user.id])}` });
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const res = await endpoints.saveAttendanceRegister(date, entries);
      const sk = res.skipped.map((s) => ({ name: rowsById[s.userId]?.user.name ?? "Employee", reason: s.reason }));
      setSkipped(sk);
      setResult({
        kind: sk.length ? "warning" : "success",
        message: `Saved ${res.saved} employee${res.saved === 1 ? "" : "s"}${sk.length ? ` · ${sk.length} skipped` : ""}`,
      });
      void Haptics.notificationAsync(sk.length ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success);
      // Keep the edits of skipped rows so they can be fixed and saved again.
      const keep = Object.fromEntries(res.skipped.filter((s) => drafts[s.userId]).map((s) => [s.userId, drafts[s.userId]]));
      await load(date, keep);
    } catch (e) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setResult({ kind: "warning", message: errorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  const afterRecordChange = (message: string) => {
    const id = editing?.row.user.id;
    setEditing(null);
    setResult({ kind: "success", message });
    // Keep other rows' unsaved edits; the edited employee reloads from the server.
    const keep = Object.fromEntries(dirtyIds.filter((x) => x !== id).map((x) => [x, drafts[x]]));
    void load(date, keep);
  };

  if (loading && !reg) return <Loading label="Loading register…" />;
  if (error && !reg) {
    if (isFeatureOff(error)) return <FeatureOff />;
    return <ErrorState message={errorMessage(error)} onRetry={() => void load(date)} />;
  }
  if (!reg || !date) return null;

  const atToday = !!today && date >= today;
  const chips: { key: SummaryKey; label: string; color: string }[] = [
    { key: "PRESENT", label: "Present", color: t.success },
    { key: "HALF_DAY", label: "Half day", color: "#7FB89A" },
    { key: "ABSENT", label: "Absent", color: t.danger },
    { key: "LEAVE", label: "Leave", color: t.info },
    { key: "NONE", label: "Not marked", color: t.textMuted },
  ];

  const header = (
    <View style={{ gap: space.md }}>
      <Card style={styles.dateBar}>
        <Pressable
          onPress={() => goTo(shiftDate(date, -1))}
          accessibilityRole="button"
          accessibilityLabel="Previous day"
          style={({ pressed }) => [styles.arrow, { backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
        >
          <Ionicons name="chevron-back" size={28} color={t.text} />
        </Pressable>
        <Pressable
          style={{ flex: 1, alignItems: "center" }}
          onPress={() => !atToday && today && goTo(today)}
          accessibilityRole="button"
          accessibilityLabel={atToday ? `Showing ${dateTitle(date, today)}` : "Jump to today"}
        >
          <AppText variant="h3">{dateTitle(date, today)}</AppText>
          <AppText variant="small">{atToday ? date : `${date} · tap for today`}</AppText>
        </Pressable>
        <Pressable
          onPress={() => !atToday && goTo(shiftDate(date, 1))}
          disabled={atToday}
          accessibilityRole="button"
          accessibilityLabel="Next day"
          accessibilityState={{ disabled: atToday }}
          style={({ pressed }) => [styles.arrow, { opacity: atToday ? 0.3 : 1, backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
        >
          <Ionicons name="chevron-forward" size={28} color={t.text} />
        </Pressable>
      </Card>

      {summary ? (
        <View style={styles.chips}>
          {chips.map((c) => (
            <View key={c.key} style={[styles.chip, { borderColor: t.border, backgroundColor: t.surface }]}>
              <View style={[styles.dot, { backgroundColor: c.color }]} />
              <AppText style={{ fontWeight: "800", fontSize: font.lg }}>{summary[c.key]}</AppText>
              <AppText variant="small">{c.label}</AppText>
            </View>
          ))}
        </View>
      ) : null}

      {result ? <Notice kind={result.kind} message={result.message} /> : null}
      {skipped.length ? (
        <Notice kind="error" title="Not saved" message={skipped.map((s) => `${s.name}: ${s.reason}`).join("\n")} />
      ) : null}
      {error ? <Notice kind="error" message={errorMessage(error)} /> : null}
      <AppText variant="small">Tap P / HD / A / L, adjust times if needed, then Save. Long-press a card or tap ⋯ to edit or delete a saved record.</AppText>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <OfflineBanner />
      <FlatList
        data={reg.staff}
        keyExtractor={(r) => `${reg.date}:${r.user.id}`}
        ListHeaderComponent={header}
        ListEmptyComponent={<EmptyState icon="people-outline" title="No staff in this outlet" message="Add employees on the CANAVO web console." />}
        renderItem={({ item }) => (
          <EmployeeCard
            row={item}
            draft={drafts[item.user.id]}
            changed={isChanged(item, drafts[item.user.id])}
            onDraft={onDraft}
            onEdit={onEdit}
          />
        )}
        contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: 140 + insets.bottom }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() =>
              confirmDiscard(() => {
                setRefreshing(true);
                void load(date);
              })
            }
            tintColor={t.primary}
            colors={[t.primary]}
          />
        }
      />

      <View style={[styles.bar, { backgroundColor: t.surface, borderColor: t.border, paddingBottom: Math.max(insets.bottom, space.md) }]}>
        <Button
          title={unmarked ? `Mark all present (${unmarked})` : "All marked"}
          icon="checkmark-done"
          variant="secondary"
          size="md"
          style={{ flex: 1 }}
          disabled={!unmarked || saving}
          onPress={doMarkAll}
        />
        <Button
          title={entries.length ? `Save (${entries.length})` : "Save"}
          icon="save-outline"
          size="md"
          style={{ flex: 1 }}
          loading={saving}
          disabled={!entries.length}
          onPress={save}
        />
      </View>

      <RecordSheet row={editing?.row ?? null} record={editing?.record ?? null} onClose={() => setEditing(null)} onChanged={afterRecordChange} />
    </View>
  );
}

export default withAccess(["attendance:manage"], StaffAttendance);

const styles = StyleSheet.create({
  dateBar: { flexDirection: "row", alignItems: "center", paddingVertical: space.xs, paddingHorizontal: space.xs },
  arrow: { width: TAP + 4, height: TAP + 4, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.md, minHeight: 40 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  tag: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4 },
  info: { borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 6, gap: space.sm },
  more: { width: 44, height: 36, alignItems: "center", justifyContent: "center" },
  addNote: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 40, alignSelf: "flex-start" },
  badge: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", gap: space.sm, paddingTop: space.md, paddingHorizontal: space.lg, borderTopWidth: StyleSheet.hairlineWidth },
});

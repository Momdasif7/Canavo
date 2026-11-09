import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { leaveRequestSchema } from "@canavo/shared";
import { Screen } from "../src/components/Screen";
import { AppText, Button, Card, Chip, Input, Loading, Notice, Row, Segmented } from "../src/components/ui";
import { endpoints, errorMessage } from "../src/lib/api";
import { formatMinutes, formatTime, humanize, ym, ymd } from "../src/lib/format";
import type { AttendanceCalendar, AttendanceRecord, CalendarDay, LeaveRequest, LeaveType } from "../src/lib/types";
import { radius, space, useTheme, type Palette } from "../src/theme";
import { FaceCheckCard } from "../src/attendance/FaceCheck";
import { withAccess } from "../src/auth/RequireAccess";

type Tab = "calendar" | "leave";
type DayKind = "PRESENT" | "LATE" | "HALF_DAY" | "LEAVE" | "ABSENT" | "UPCOMING";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const LEAVE_TYPES: { value: LeaveType; label: string }[] = [
  { value: "CASUAL", label: "Casual" },
  { value: "SICK", label: "Sick" },
  { value: "HALF_DAY", label: "Half day" },
  { value: "UNPAID", label: "Unpaid" },
];

function dayKind(d: CalendarDay): DayKind {
  if (d.status === "PRESENT" && d.lateByMinutes > 0) return "LATE";
  return d.status;
}

function kindColors(t: Palette): Record<DayKind, { bg: string; fg: string; label: string }> {
  return {
    PRESENT: { bg: t.success, fg: "#fff", label: "Present" },
    LATE: { bg: "#E9A23B", fg: "#fff", label: "Late" },
    HALF_DAY: { bg: "#7FB89A", fg: "#fff", label: "Half day" },
    LEAVE: { bg: t.info, fg: "#fff", label: "Leave" },
    ABSENT: { bg: t.danger, fg: "#fff", label: "Absent" },
    UPCOMING: { bg: t.surfaceAlt, fg: t.textMuted, label: "Upcoming" },
  };
}

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number);
  return ym(new Date(y, m - 1 + delta, 1));
}

function monthTitle(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

function Attendance() {
  const [tab, setTab] = useState<Tab>("calendar");
  return (
    <Screen edges={[]}>
      <FaceCheckCard />
      <Segmented
        options={[
          { value: "calendar", label: "Calendar" },
          { value: "leave", label: "Leave" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "calendar" ? <CalendarTab /> : <LeaveTab />}
    </Screen>
  );
}

function CalendarTab() {
  const t = useTheme();
  const colors = kindColors(t);
  const [month, setMonth] = useState(ym());
  const [cal, setCal] = useState<AttendanceCalendar | null>(null);
  const [recent, setRecent] = useState<AttendanceRecord[]>([]);
  const [selected, setSelected] = useState<CalendarDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [c, s] = await Promise.all([endpoints.calendar(month), endpoints.attendanceStatus()]);
      setCal(c);
      setRecent(s.recent);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => {
    setSelected(null);
    void load();
  }, [load]);

  const cells = useMemo(() => {
    if (!cal) return [];
    const [y, m] = month.split("-").map(Number);
    const lead = new Date(y, m - 1, 1).getDay();
    return [...Array<null>(lead).fill(null), ...cal.days];
  }, [cal, month]);

  const totals = useMemo(() => {
    const out: Partial<Record<DayKind, number>> = {};
    cal?.days.forEach((d) => {
      const k = dayKind(d);
      out[k] = (out[k] ?? 0) + 1;
    });
    return out;
  }, [cal]);

  const today = ymd();

  return (
    <>
      <Card style={{ gap: space.md }}>
        <Row style={{ justifyContent: "space-between" }}>
          <Pressable onPress={() => setMonth(shiftMonth(month, -1))} style={styles.navBtn} accessibilityLabel="Previous month">
            <Ionicons name="chevron-back" size={26} color={t.text} />
          </Pressable>
          <AppText variant="h3">{monthTitle(month)}</AppText>
          <Pressable
            onPress={() => setMonth(shiftMonth(month, 1))}
            disabled={month >= ym()}
            style={[styles.navBtn, month >= ym() && { opacity: 0.3 }]}
            accessibilityLabel="Next month"
          >
            <Ionicons name="chevron-forward" size={26} color={t.text} />
          </Pressable>
        </Row>

        {loading && !cal ? (
          <View style={{ height: 280 }}>
            <Loading />
          </View>
        ) : error ? (
          <Notice kind="error" message={error} />
        ) : (
          <>
            <View style={styles.grid}>
              {WEEKDAYS.map((w, i) => (
                <View key={`h${i}`} style={styles.cell}>
                  <AppText variant="small" style={{ fontWeight: "700" }}>
                    {w}
                  </AppText>
                </View>
              ))}
              {cells.map((d, i) => {
                if (!d) return <View key={`e${i}`} style={styles.cell} />;
                const k = colors[dayKind(d)];
                const isSel = selected?.date === d.date;
                return (
                  <View key={d.date} style={styles.cell}>
                    <Pressable
                      onPress={() => setSelected(d)}
                      accessibilityLabel={`${d.date}: ${k.label}`}
                      style={[
                        styles.day,
                        { backgroundColor: k.bg },
                        d.date === today && { borderWidth: 2, borderColor: t.text },
                        isSel && { transform: [{ scale: 1.1 }] },
                      ]}
                    >
                      <AppText style={{ color: k.fg, fontWeight: "800" }}>{Number(d.date.slice(8))}</AppText>
                    </Pressable>
                  </View>
                );
              })}
            </View>
            <View style={styles.legend}>
              {(Object.keys(colors) as DayKind[])
                .filter((k) => k !== "UPCOMING")
                .map((k) => (
                  <Row key={k} style={{ gap: 6 }}>
                    <View style={[styles.swatch, { backgroundColor: colors[k].bg }]} />
                    <AppText variant="small">
                      {colors[k].label} {totals[k] ?? 0}
                    </AppText>
                  </Row>
                ))}
            </View>
          </>
        )}
      </Card>

      {selected ? (
        <Card style={{ gap: space.xs }}>
          <AppText variant="h3">{selected.date}</AppText>
          <AppText>{colors[dayKind(selected)].label}</AppText>
          {selected.records.map((r) => (
            <AppText key={r.id} variant="muted">
              {formatTime(r.clockInAt)} – {r.clockOutAt ? formatTime(r.clockOutAt) : "open"}
              {r.workedMinutes != null ? ` · ${formatMinutes(r.workedMinutes)}` : ""}
            </AppText>
          ))}
          {selected.lateByMinutes > 0 ? <AppText variant="muted">Late by {selected.lateByMinutes} min</AppText> : null}
          {selected.overtimeMinutes > 0 ? (
            <AppText variant="muted">Overtime {formatMinutes(selected.overtimeMinutes)}</AppText>
          ) : null}
        </Card>
      ) : null}

      <AppText variant="h3">Recent records</AppText>
      {recent.length === 0 && !loading ? <AppText variant="muted">No attendance records yet.</AppText> : null}
      {recent.map((r) => (
        <Card key={r.id} style={{ gap: 4, paddingVertical: space.md }}>
          <Row style={{ justifyContent: "space-between" }}>
            <AppText style={{ fontWeight: "700" }}>{r.workDate}</AppText>
            <AppText variant="small" color={r.clockOutAt ? t.textMuted : t.success} style={{ fontWeight: "700" }}>
              {r.clockOutAt ? humanize(r.status) : "On duty"}
            </AppText>
          </Row>
          <AppText variant="muted">
            In {formatTime(r.clockInAt)}
            {r.clockOutAt ? ` · Out ${formatTime(r.clockOutAt)}` : ""}
            {r.workedMinutes != null ? ` · ${formatMinutes(r.workedMinutes)}` : ""}
          </AppText>
          {r.lateByMinutes > 0 || r.earlyByMinutes > 0 || r.overtimeMinutes > 0 ? (
            <AppText variant="small">
              {[
                r.lateByMinutes > 0 && `Late ${r.lateByMinutes}m`,
                r.earlyByMinutes > 0 && `Left early ${r.earlyByMinutes}m`,
                r.overtimeMinutes > 0 && `OT ${formatMinutes(r.overtimeMinutes)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </AppText>
          ) : null}
        </Card>
      ))}
    </>
  );
}

function LeaveTab() {
  const t = useTheme();
  const [fromDate, setFromDate] = useState(ymd());
  const [toDate, setToDate] = useState(ymd());
  const [type, setType] = useState<LeaveType>("CASUAL");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [leaves, setLeaves] = useState<LeaveRequest[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setListError(null);
    try {
      setLeaves(await endpoints.myLeaves());
    } catch (e) {
      setListError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async () => {
    setError(null);
    setDone(null);
    const parsed = leaveRequestSchema.safeParse({
      fromDate: fromDate.trim(),
      toDate: (type === "HALF_DAY" ? fromDate : toDate).trim(),
      type,
      reason: reason.trim(),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError(
        issue?.path[0] === "fromDate" || issue?.path[0] === "toDate"
          ? "Use dates like 2026-10-15"
          : (issue?.message ?? "Check the form"),
      );
      return;
    }
    setBusy(true);
    try {
      await endpoints.applyLeave(parsed.data);
      setDone("Leave request sent to your manager.");
      setReason("");
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const statusColor = (s: LeaveRequest["status"]) =>
    s === "APPROVED" ? t.success : s === "REJECTED" ? t.danger : t.warning;

  return (
    <>
      <Card style={{ gap: space.md }}>
        <AppText variant="h3">Apply for leave</AppText>
        <View style={styles.chips}>
          {LEAVE_TYPES.map((l) => (
            <Chip key={l.value} label={l.label} selected={type === l.value} onPress={() => setType(l.value)} />
          ))}
        </View>
        <Row style={{ alignItems: "flex-start" }}>
          <View style={{ flex: 1 }}>
            <Input label={type === "HALF_DAY" ? "Date" : "From"} value={fromDate} onChangeText={setFromDate} placeholder="YYYY-MM-DD" maxLength={10} />
          </View>
          {type !== "HALF_DAY" ? (
            <View style={{ flex: 1 }}>
              <Input label="To" value={toDate} onChangeText={setToDate} placeholder="YYYY-MM-DD" maxLength={10} />
            </View>
          ) : null}
        </Row>
        <Input label="Reason (optional)" value={reason} onChangeText={setReason} multiline maxLength={500} style={{ minHeight: 80, textAlignVertical: "top", paddingTop: 12 }} />
        {error ? <Notice kind="error" message={error} /> : null}
        {done ? <Notice kind="success" message={done} /> : null}
        <Button title="Submit request" icon="send" loading={busy} onPress={submit} />
      </Card>

      <AppText variant="h3">My leave requests</AppText>
      {listError ? <Notice kind="error" message={listError} /> : null}
      {leaves === null && !listError ? <Loading /> : null}
      {leaves?.length === 0 ? <AppText variant="muted">No leave requests yet.</AppText> : null}
      {leaves?.map((l) => (
        <Card key={l.id} style={{ gap: 4, paddingVertical: space.md }}>
          <Row style={{ justifyContent: "space-between" }}>
            <AppText style={{ fontWeight: "700" }}>
              {humanize(l.type)} · {l.fromDate === l.toDate ? l.fromDate : `${l.fromDate} → ${l.toDate}`}
            </AppText>
            <View style={[styles.badge, { backgroundColor: statusColor(l.status) }]}>
              <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>{l.status}</AppText>
            </View>
          </Row>
          {l.reason ? <AppText variant="muted">{l.reason}</AppText> : null}
        </Card>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  navBtn: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 3, alignItems: "center", justifyContent: "center" },
  day: { flex: 1, alignSelf: "stretch", borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  swatch: { width: 14, height: 14, borderRadius: 3 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill },
});

export default withAccess(["attendance:self", "attendance:manage"], Attendance);

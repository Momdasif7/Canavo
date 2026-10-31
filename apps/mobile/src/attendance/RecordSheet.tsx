import React, { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";
import * as Haptics from "expo-haptics";
import { Sheet } from "../components/Sheet";
import { AppText, Button, Input, Notice, Row } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import type { AttendanceRegisterRow, ManualStatus, RegisterRecord } from "../lib/types";
import { space } from "../theme";
import { describeRecord, hhmmAt, isOvernight, needsTimes, shiftTimes, STATUS_LABEL, type RecordPatch } from "./register";
import { StatusButtons } from "./StatusButtons";
import { TimeField } from "./TimeField";

/**
 * Edit or delete one existing attendance record (self clock-in or manual):
 * PATCH /attendance/:id and DELETE /attendance/:id.
 */
export function RecordSheet({
  row,
  record,
  onClose,
  onChanged,
}: {
  row: AttendanceRegisterRow | null;
  record: RegisterRecord | null;
  onClose: () => void;
  /** Called after a successful edit / delete with a message to show */
  onChanged: (message: string) => void;
}) {
  const [status, setStatus] = useState<ManualStatus>("PRESENT");
  const [clockIn, setClockIn] = useState<string | null>(null);
  const [clockOut, setClockOut] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timedBefore = record ? needsTimes(record.status) : false;
  const origIn = record && timedBefore ? hhmmAt(record.clockInAt) : null;
  const origOut = record && timedBefore && record.clockOutAt ? hhmmAt(record.clockOutAt) : null;

  useEffect(() => {
    if (!record) return;
    setStatus(record.status);
    setClockIn(origIn);
    setClockOut(origOut);
    setNote(record.note ?? "");
    setError(null);
    setBusy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id]);

  if (!row || !record) return <Sheet visible={false} onClose={onClose}>{null}</Sheet>;

  const shift = shiftTimes(row);
  const timed = needsTimes(status);

  const pick = (s: ManualStatus) => {
    setStatus(s);
    if (needsTimes(s) && !clockIn) {
      setClockIn(shift.startTime);
      if (s === "PRESENT" && !clockOut) setClockOut(shift.endTime);
    }
  };

  const patch = (): RecordPatch => {
    const p: RecordPatch = {};
    if (status !== record.status) p.status = status;
    if (timed) {
      // A record that was absent / leave has no real times: always send them.
      if (clockIn && (clockIn !== origIn || !timedBefore)) p.clockIn = clockIn;
      if (clockOut !== origOut || (!timedBefore && clockOut)) p.clockOut = clockOut;
    }
    if (note.trim() !== (record.note ?? "").trim()) p.note = note.trim() || null;
    return p;
  };

  const save = async () => {
    if (timed && !clockIn) return setError("Enter the clock-in time");
    const p = patch();
    if (!Object.keys(p).length) return onClose();
    setBusy("save");
    setError(null);
    try {
      await endpoints.updateAttendanceRecord(record.id, p);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onChanged(`${row.user.name}: record updated`);
    } catch (e) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async () => {
    setBusy("delete");
    setError(null);
    try {
      await endpoints.deleteAttendanceRecord(record.id);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      onChanged(`${row.user.name}: record deleted`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmDelete = () => {
    const self = record.source === "SELF";
    Alert.alert(
      self ? "Delete a self clock-in?" : "Delete this record?",
      self
        ? `${row.user.name} clocked in themselves with GPS. Deleting removes that proof of attendance for good. Edit it instead if only the times are wrong.`
        : `${row.user.name}'s ${STATUS_LABEL[record.status].toLowerCase()} record for this day will be removed.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void doDelete() },
      ],
    );
  };

  return (
    <Sheet visible onClose={onClose} title={`Edit · ${row.user.name}`}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.lg }} keyboardShouldPersistTaps="handled">
        <AppText variant="small">
          {record.source === "SELF" ? "Self clock-in" : "Manual entry"} · {describeRecord(record)}
        </AppText>
        <StatusButtons value={status} onChange={pick} name={row.user.name} />
        {timed ? (
          <Row style={{ alignItems: "flex-start" }}>
            <TimeField label="In" value={clockIn} onChange={setClockIn} fallback={shift.startTime} />
            <TimeField
              label="Out"
              value={clockOut}
              onChange={setClockOut}
              fallback={shift.endTime}
              placeholder="Not out"
              clearable
              hint={isOvernight(clockIn, clockOut) ? "Next day" : undefined}
            />
          </Row>
        ) : null}
        <Input label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. Forgot to clock in" maxLength={300} />
        {error ? <Notice kind="error" message={error} /> : null}
        <Button title="Save changes" icon="checkmark" loading={busy === "save"} disabled={!!busy} onPress={save} />
        <View style={{ flexDirection: "row", gap: space.sm }}>
          <Button title="Cancel" variant="secondary" style={{ flex: 1 }} disabled={!!busy} onPress={onClose} />
          <Button title="Delete" icon="trash-outline" variant="danger" style={{ flex: 1 }} loading={busy === "delete"} disabled={!!busy} onPress={confirmDelete} />
        </View>
      </ScrollView>
    </Sheet>
  );
}

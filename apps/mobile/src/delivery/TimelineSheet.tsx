import React, { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Sheet } from "../components/Sheet";
import { AppText, Loading, Notice, Row } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import { formatTime, inr } from "../lib/format";
import type { PartnerTimeline } from "../lib/types";
import { space, useTheme, type Palette } from "../theme";

type IconName = keyof typeof Ionicons.glyphMap;

function eventStyle(t: Palette, type: string): { icon: IconName; color: string } {
  switch (type) {
    case "CLOCK_IN":
      return { icon: "log-in-outline", color: t.success };
    case "CLOCK_OUT":
      return { icon: "log-out-outline", color: t.textMuted };
    case "ASSIGNED":
      return { icon: "person-add-outline", color: t.info };
    case "ACCEPTED":
      return { icon: "hand-left-outline", color: t.info };
    case "PICKED":
      return { icon: "bicycle", color: t.primary };
    case "DELIVERED":
      return { icon: "checkmark-done", color: t.success };
    case "COLLECTED":
      return { icon: "cash", color: t.warning };
    case "HANDOVER":
      return { icon: "wallet", color: t.success };
    case "ISSUE":
      return { icon: "warning", color: t.danger };
    default:
      return { icon: "ellipse-outline", color: t.textMuted };
  }
}

export const dayTitle = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

/** Manager: one partner's day as a timeline (duty, delivery steps, cash, handovers, problems). */
export function TimelineSheet({ target, onClose }: { target: { agentId: string; name: string; date: string } | null; onClose: () => void }) {
  const t = useTheme();
  const [data, setData] = useState<PartnerTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setData(null);
    setError(null);
    endpoints
      .partnerTimeline(target.agentId, target.date)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target) return null;
  return (
    <Sheet visible={!!target} onClose={onClose} title={`${target.name} · ${dayTitle(target.date)}`}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.lg }}>
        {error ? <Notice kind="error" message={error} /> : null}
        {!data && !error ? (
          <View style={{ height: 160 }}>
            <Loading />
          </View>
        ) : null}
        {data ? (
          <>
            <Row style={{ justifyContent: "space-between" }}>
              <AppText variant="small">Opening cash {inr(data.openingBalance)}</AppText>
              <AppText variant="small" style={{ fontWeight: "800" }}>
                Closing {inr(data.closingBalance)}
              </AppText>
            </Row>
            {data.events.length === 0 ? <AppText variant="muted">No activity on this day.</AppText> : null}
            {data.events.map((e, i) => {
              const s = eventStyle(t, e.type);
              return (
                <View key={`${e.at}-${i}`} style={styles.event}>
                  <AppText variant="small" style={styles.time}>
                    {formatTime(e.at)}
                  </AppText>
                  <View style={[styles.icon, { backgroundColor: t.surfaceAlt }]}>
                    <Ionicons name={s.icon} size={18} color={s.color} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <AppText style={{ fontWeight: "800" }}>{e.title}</AppText>
                    {e.detail ? <AppText variant="small">{e.detail}</AppText> : null}
                  </View>
                  {e.amount != null ? (
                    <AppText style={{ fontWeight: "800" }} color={s.color}>
                      {inr(e.amount)}
                    </AppText>
                  ) : null}
                </View>
              );
            })}
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  event: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 48 },
  time: { width: 64, fontWeight: "700" },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
});

import { WEEKDAYS } from "./shared";

const FULL_DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;

/** Weekday × hour grid of paid visits (`grid[dow 0=Sun][hour]`), shaded with the primary colour. */
export function VisitHeatmap({ grid }: { grid: number[][] }) {
  const max = Math.max(0, ...grid.flat());
  const total = grid.flat().reduce((s, n) => s + n, 0);
  if (!total) return <p className="py-6 text-center text-sm text-muted">No paid visits yet.</p>;

  let peak = { dow: 0, hour: 0, n: 0 };
  grid.forEach((row, dow) => row.forEach((n, hour) => n > peak.n && (peak = { dow, hour, n })));

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-separate" style={{ borderSpacing: 3 }} aria-label="Visits by weekday and hour">
          <thead>
            <tr>
              <th className="w-10" />
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} scope="col" className="text-[10px] font-medium text-muted">
                  {h % 3 === 0 ? hourLabel(h) : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, dow) => (
              <tr key={dow}>
                <th scope="row" className="pr-1 text-left text-xs font-semibold text-muted">
                  {WEEKDAYS[dow]}
                </th>
                {row.map((n, hour) => {
                  const label = `${FULL_DAYS[dow]} ${hourLabel(hour)}–${hourLabel((hour + 1) % 24)}: ${n} visit${n === 1 ? "" : "s"}`;
                  return (
                    <td key={hour} className="p-0">
                      <div
                        title={label}
                        aria-label={label}
                        className="h-6 rounded-[4px] bg-surface-2 ring-1 ring-inset ring-line/60"
                        style={n ? { backgroundColor: `rgba(255, 107, 53, ${0.18 + 0.82 * (n / max)})` } : undefined}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span>
          Busiest: <span className="font-semibold text-fg">{FULL_DAYS[peak.dow]}, {hourLabel(peak.hour)}</span> ({peak.n} visits)
        </span>
        <span className="flex items-center gap-1.5" aria-hidden>
          Fewer
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <span
              key={f}
              className="h-3 w-4 rounded-[3px] bg-surface-2 ring-1 ring-inset ring-line/60"
              style={f ? { backgroundColor: `rgba(255, 107, 53, ${0.18 + 0.82 * f})` } : undefined}
            />
          ))}
          More
        </span>
      </div>
    </div>
  );
}

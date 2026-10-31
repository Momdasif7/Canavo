/**
 * All money in CANAVO is stored and computed as integer paise (₹1 = 100 paise)
 * to avoid floating point drift in GST calculations.
 */
export type Paise = number;

export const toPaise = (rupees: number): Paise => Math.round(rupees * 100);
export const toRupees = (paise: Paise): number => paise / 100;

export function formatINR(paise: Paise, opts: { symbol?: boolean } = {}): string {
  const formatted = new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(paise) / 100);
  const sign = paise < 0 ? "-" : "";
  return opts.symbol === false ? `${sign}${formatted}` : `${sign}₹${formatted}`;
}

/**
 * Split `total` across `weights` proportionally so that the parts sum exactly to
 * `total` (largest-remainder method). Used to distribute bill discounts and
 * service charges across lines without losing a paisa.
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floored = raw.map(Math.floor);
  let remainder = total - floored.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; remainder > 0; k = (k + 1) % order.length, remainder--) {
    floored[order[k].i] += 1;
  }
  return floored;
}

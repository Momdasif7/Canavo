/** Same rule as the API's equalSplit: parts sum exactly to total, first ones carry the extra paise. */
export function equalSplitPreview(total: number, parts: number): number[] {
  const n = Math.max(1, Math.floor(parts));
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

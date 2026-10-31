/**
 * Tiny fuzzy matcher for the POS search box. Scores contiguous substring hits
 * highest, then word-prefix hits ("vp" → "Vada Pav"), then in-order
 * subsequences. Returns 0 for no match.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const t = text.toLowerCase();
  if (!q) return 1;
  const idx = t.replace(/\s+/g, "").indexOf(q);
  if (idx === 0) return 100;
  if (t.includes(query.toLowerCase().trim())) return 90 - Math.min(idx, 20);
  if (idx > 0) return 70 - Math.min(idx, 20);

  const initials = t
    .split(/[\s()\-/]+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("");
  if (initials.startsWith(q)) return 60;

  // In-order subsequence; reward consecutive runs, penalise gaps.
  let ti = 0;
  let score = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    run = found === ti ? run + 1 : 0;
    score += 1 + run;
    ti = found + 1;
  }
  return Math.min(50, 10 + score);
}

export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(query, key(item)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.item);
}

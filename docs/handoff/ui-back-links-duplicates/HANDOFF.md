# HANDOFF — `wip/ui-back-links-duplicates` (Requests 3 + 6)

> **Status: WORK IN PROGRESS (≈ 75 %).** The two named fixes are done. The full-app sweep runs and has removed most duplicates; one more triage round is left. Don't merge into `feat/market-leader` until the "Still to do" list is done.
> Branched from `feat/market-leader` @ `cba9527`. Handed over 2026-11-07.

## The requests

3. **Table QR codes page:** add a back button that returns to Tables.
6. **Duplicate buttons:**
   a) the **Share kit** on Settings → Online ordering shows a duplicate; keep one;
   b) check **every page** (owner, manager, cashier and every other role; desktop and phone) for duplicate buttons doing the same thing, and remove the extras. The sweep is saved so it can be re-run.

## Done (5 commits; typecheck ✅; unit tests ✅ 51 shared + 160 api)

| Commit | What |
|---|---|
| `77edb89` | **Request 3 done:** Table QR codes page gets a shared, accessible `BackLink` to Tables (`components/layout/PageHeader.tsx`, `tables/qr-codes/page.tsx`) |
| `8cb0c16` | **Request 6a done:** Share kit: removed the duplicate **Copy message** button (it copied the same link as **Copy**, with the same text the WhatsApp share button sends). The remaining button is labelled **Copy link** (`components/storefront/OnlineOrderingSettings.tsx`) |
| `b0f24dd` | **Request 6b:** Playwright duplicate-button sweep: all 11 roles + signed-out pages, desktop 1440×900 and phone 390×844, about 80 routes. Visible elements only, grouped by accessible name + destination, with a documented allowlist and console-error capture. Files: `apps/web/e2e/*`, `apps/web/playwright.config.ts`, script `npm run test:e2e:sweep -w @canavo/web` |
| `c4a209c` | Duplicates removed: Khata header link + Khata back link (section tabs cover them), GST & Taxes inline link (the tab covers it), empty-state "Start audit" (the header button covers it); Customers sub-pages use the shared BackLink |
| `1df5a93` | Platform business pages use the shared BackLink ("Back to Businesses") |
| WIP commit (handover) | Sweep probe/allowlist refinements in progress, plus `docs/qa/ui-duplicate-sweep.md` (method, allowlist, findings) and `docs/qa/ui-duplicate-sweep-results.md` (generated) |

## Still to do

1. **Re-run the sweep after the fixes** (see "How to re-run" in `docs/qa/ui-duplicate-sweep.md`). The committed `ui-duplicate-sweep-results.md` comes from a run **part-way through the fixes**: it still lists **54 "unexplained" groups**. Many are expected to be false positives the agent was fixing in the probe when it stopped, chiefly a page's new **back link** counted against the sidebar/section-tab link to the same page (e.g. cashier `/customers/khata` → "Customers" ×2–3). Others are real duplicates, e.g. delivery `/delivery`: "Clock in" ×2.
2. **Triage each remaining group:** if it's a real duplicate, remove the extra (keep the most discoverable one); if it's a legitimate pattern, add an allowlist rule **with a reason** in `apps/web/e2e/sweep-config.ts`. The goal: **0 unexplained duplicates**.
3. Don't restructure the **Integrations / WhatsApp settings** or the **`/o/<store>` storefront and delivery screens** here. Those are on `wip/store-integrations` and `wip/online-ordering-delivery-mode`. Re-run the sweep after those branches are merged.
4. Finish `docs/qa/ui-duplicate-sweep.md` (final counts, what changed with file/line, what was left and why), and regenerate the results file.
5. `npm run lint`, `npm run build -w @canavo/web`.

## How to run

```bash
npm ci && npm run build -w @canavo/shared && npx playwright install chromium
# start API + web on your own ports against a throwaway DB (details in docs/qa/ui-duplicate-sweep.md), then:
SWEEP_BASE_URL=http://localhost:3302 SWEEP_STORE_SLUG=demo-canteen npm run test:e2e:sweep -w @canavo/web
SWEEP_ROLES=owner,cashier ...   # subset of roles
```
A full run takes about 6 minutes with 4 workers and uses 11 logins (the API allows 50 logins per 15 min per IP).

## Merge notes

- New dev dependency `@playwright/test` in `apps/web` (`package-lock.json` changed). Regenerate the lock rather than hand-merging conflicts.
- `components/storefront/OnlineOrderingSettings.tsx` (Share kit) is also changed on `wip/online-ordering-delivery-mode`, so expect a small conflict.
- `.gitignore` gained Playwright output folders. `feat/market-leader` also gets new `.gitignore` lines (agent worktrees, test reports), so keep both.

# Feature flags

Per-hotel switches for new behaviour. Every flag is **OFF** unless the Super Admin turns it on for a hotel (Platform → Business → Features). A flag only takes effect when the hotel also has the modules it requires. Design: [ADR 0004](adr/0004-feature-flags.md). Registry: `packages/shared/src/features.ts`.

| Flag | What it does | Requires | Added | On for |
|---|---|---|---|---|
| `AUTO_STOCK_OUT` | Menu items, or single sizes, whose ingredient stock can't cover one portion become unavailable on the POS, waiter, QR and kiosk menus. They come back when stock is received. Off: items stay sellable, and stock can go negative. | `INVENTORY` | Phase 1 (from the 2026-10-31 request) | Demo Hotel (D14) |

## Adding a flag

1. Add the key to `FEATURES`, with its label, description and `requires`.
2. Gate the server behaviour with `featureOn("KEY")`. Gate the UI with the flags returned by `/auth/me`.
3. Put any side effect of switching it on or off in `apps/api/src/services/features.ts`.
4. Test both states, and test that a missing required module means off.
5. Add a row to this table.

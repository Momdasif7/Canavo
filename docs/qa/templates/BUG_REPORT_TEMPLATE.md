# BUG-XXX: <one-line summary: what is wrong, where>

| Field | Value |
|---|---|
| ID | BUG-XXX |
| Severity | P0 data leak / money wrong / data loss / security · P1 feature broken · P2 UX · P3 cosmetic |
| Priority | High / Medium / Low (defaults to severity) |
| Module | e.g. Billing, Delivery, Inventory |
| Role(s) | e.g. Cashier, Manager |
| Environment | LOCAL / TEST-DB / STAGING-LIKE / PROD-LIKE / device; commit SHA; browser or device + OS |
| Found by / date | Name, YYYY-MM-DD |
| Requirement | RTM ID(s), e.g. BILL-07 |
| Test case | TC ID that found it (automated test path or manual TC) |
| Status | New / Triaged / In progress / Fixed / Verified / Closed / Rejected / Deferred / Reopened |

## Preconditions

- Hotel / outlet / user used, settings that matter (GST on/off, modules), data state.

## Steps to reproduce

1. …
2. …
3. …

## Expected result

What should happen, with the rule or source it comes from (spec, README, GST rule).

## Actual result

What happens instead. Include exact values (₹ amounts in paise and rupees, status codes, messages).

## Evidence

- Request/response (curl or HTTP log), screenshot, video, SQL query and its result, log lines (PII removed).

## Impact

Who is affected and how often; money or data at risk.

## Root cause (filled when fixed)

File and line, why it happened.

## Fix

- Failing test added: `<path>::<test name>` (fails on `<old SHA>`).
- Fix commit: `<SHA>`; test now passes.
- Regression run: suites run and their result.

## Verification

Who verified, when, on which build.

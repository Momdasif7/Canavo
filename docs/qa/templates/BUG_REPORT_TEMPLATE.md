# Bug report template

> Copy this block into a GitHub issue, or add one row per field to `docs/qa/BUGS.csv`.
> One defect per report. Write it so someone who has never seen the bug can reproduce it in under 5 minutes.

---

## BUG-NNN — <one-line title: what is wrong, where>

| Field | Value |
|---|---|
| **ID** | BUG-NNN (next free number in `BUGS.csv`, never reused) |
| **Severity** | P0 / P1 / P2 / P3 — see definitions below |
| **Module** | Billing · Kitchen · Tables · Delivery · Reservations · Inventory · Customers · Offers · Attendance · Reports · Auth · Platform · Staff · Outlets/Settings · Menu · Notifications · Admin · Build |
| **Role(s)** | Super Admin · Owner · Manager · Cashier · Kitchen · Inventory · Delivery · n/a |
| **Environment** | E1 local / E2 staging-Docker / E3 prod-like / CI / Device — include: app (web/mobile/API), build/commit SHA, browser + version or device + OS, server TZ, tenant (T0–T4) |
| **Found in** | Phase N / test ID / exploratory charter |
| **Status** | New · Triaged · In Progress · Fixed · Verified · Closed · Reopened · Deferred · Rejected |
| **Regression test** | ID of the failing automated test that reproduces it (required before a fix is merged) |

### Preconditions
- Logged in as `<role>@<tenant>`; outlet `<name>`; modules on: …
- Data: e.g. "menu item *Masala Dosa* ₹80 incl. 5 % GST; coupon `FEST10` with 1 use left"

### Steps to reproduce
1. …
2. …
3. …

### Expected result
What the spec / README / RTM requirement says should happen. Cite the requirement ID (e.g. `GST-006`).

### Actual result
What happened, including exact numbers, status codes and messages.

### Evidence
- Screenshot / video / HAR file / API request + response (secrets and PII redacted)
- Relevant log lines with timestamps and request ID
- SQL showing the bad data, if any

### Frequency
Always · Intermittent (x of y attempts) · Once

### Impact / notes
Who is affected, how often in real use, workaround, suspected cause (optional), related bugs.

---

### Severity definitions

| Sev | Meaning | Examples |
|---|---|---|
| **P0** | Data leak, wrong money, data loss, security breach | Hotel A sees Hotel B's bills; GST computed wrong; paid bill disappears after offline sync |
| **P1** | Feature broken, no reasonable workaround | Cannot accept split payment; KOTs don't reach kitchen; report returns an error |
| **P2** | Degraded UX or tooling, workaround exists | Unclear error; slow screen; test suite not hermetic |
| **P3** | Cosmetic | Misaligned receipt text, typo, colour |

### Lifecycle

`New → Triaged → In Progress → Fixed → Verified → Closed`, plus `Reopened`, `Deferred` (needs product approval) and `Rejected` (not a bug / duplicate). A fix is **Verified** only when its regression test passes and, for manual bugs, the original steps pass.

# Data retention and privacy policy (DPDP Act 2023)

CANAVO processes personal data **on behalf of each business** (the business is the Data Fiduciary; CANAVO is its
Data Processor). The platform team never reads hotel data: backups cannot be downloaded through the API, and support
access is owner-consented, time-limited and read-only.

## What is kept, why, and for how long

| Data | Purpose | Retention |
|---|---|---|
| Bills / tax invoices, bills of supply, credit notes (number, date, items, HSN, tax, totals) | GST law | At least 72 months from the due date of the annual return for that year (CGST Act s.36, Rule 56) — in practice ~8 years from the bill. Never deleted by an erasure request; customer name / phone / address on them are masked instead. |
| Customer profile (phone, name, email, birthday, anniversary, notes) | Billing, loyalty, khata (credit) | Until the customer asks for erasure (owner: Customers → profile → **Erase data**) or the business closes its account. |
| Promotional consent (`marketingOptIn`, `whatsappOptIn`, `consentAt`, `consentSource`) | Proof of consent | As long as the profile; reset on erasure. Off by default — customers created before 9 Nov 2026 have no recorded consent and are opted out. |
| Khata / wallet ledgers | Money owed either way | Erasure is refused while a balance is outstanding (legitimate use, DPDP s.7); ledgers stay with the anonymised customer row. |
| Delivery addresses, reservation names / phones, table-session names | Fulfilling that order / booking | Masked on erasure. Recommended: purge after 3 years (not automated). |
| Staff Aadhaar | Staff KYC, with recorded consent (version + who recorded it) | Last 4 digits only by default; full number only if the owner opts in (AES-256-GCM encrypted, every reveal audited). Deleted on request (`DELETE /admin/staff/:id/aadhaar`) or when the staff record is removed. |
| Audit log | Security and fraud investigation | Recommended 8 years to match GST retention (no automatic purge today). Entries carry ids, not customer contact details, except WhatsApp links logged for manual sends. |
| Login codes, refresh tokens, password-reset tokens, push tokens | Authentication | Until expiry / logout; never in data exports. |

## Data-principal requests (owner actions)

- **Access / portability:** `GET /customers/:id/data-export` (owner only) — profile, consent, bills, loyalty, khata, wallet,
  reservations, gift cards as JSON. Audited (`customer.data_export`).
- **Correction:** edit the customer (managers and owner).
- **Erasure:** `POST /customers/:id/anonymise {confirm:"ANONYMISE"}` (owner only). Name, email, dates, notes, card / employee
  code are removed; the phone becomes `ANON-<id>` so the POS can never match it again; bills keep their tax data with the
  customer name / phone removed; deliveries and reservations are masked; pending OTPs are deleted. Audited (`customer.anonymise`).
- **Withdraw consent:** turn off the toggles on the customer form; promotional messages stop at the next run.
- Respond within 30 days of the request (recommended internal SLA; the DPDP Rules set the final timeline).

## Business data export

Owners can download all of their business's data (`GET /admin/export`). Passwords, PIN hashes, token / code hashes,
TOTP secrets, Aadhaar ciphertext, integration secrets (payment / channel API keys, webhook secrets) and push tokens are
never included.

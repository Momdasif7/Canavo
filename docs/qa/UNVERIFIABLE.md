# Items that cannot be verified in this programme (living log)

Each entry says what cannot be verified, why, what we do instead, and who must close it. Entries are added as phases run.

| ID | Item | Why it can't be verified here | Substitute / mitigation | Owner to close | Logged |
|---|---|---|---|---|---|
| UV-01 | Real SMS OTP delivery (MSG91) | Ground rule 2: no real third-party credentials | OTP flow tested through the dev `devCode` fallback; manual check on staging with real keys | Product team | Phase 1 |
| UV-02 | Real UPI payment, Razorpay QR credit and webhook timing | Needs a Razorpay test account and a real UPI app | Mock QR + `/dev-simulate`; webhook signature/replay tested with locally generated secrets; manual PAYMENT checklist (Phase 15) | Product team + QA on staging | Phase 1 |
| UV-03 | WhatsApp (WATI) template messages | No credentials | `wa.me` fallback link verified | Product team | Phase 1 |
| UV-04 | Email delivery (SMTP) of scheduled reports | No SMTP credentials | Outbox files under `STORAGE_DIR/outbox` inspected | Product team | Phase 1 |
| UV-05 | Cloudinary image hosting | No credentials | Local upload storage path tested | Product team | Phase 1 |
| UV-06 | Push delivery to real phones (Expo → FCM/APNs), app killed/background | Needs physical devices and Expo project credentials | Payload/registration logic tested in code; REAL-DEVICE checklist | QA with devices | Phase 1 |
| UV-07 | Bluetooth ESC/POS printing, paper-out, cover-open, 58/80 mm alignment, ₹ and Indic glyphs | Needs printers and a dev build | ESC/POS byte output unit-tested; HARDWARE checklist | QA with hardware | Phase 1 |
| UV-08 | GPS accuracy indoors, geofence boundary walk, background location | Needs devices on site | Distance maths unit-tested; boundary walk test in REAL-DEVICE checklist | QA on site | Phase 1 |
| UV-09 | Biometric clock-in (fingerprint/face unlock) | Device hardware | Manual | QA with devices | Phase 1 |
| UV-10 | Production infrastructure (Render, Vercel, managed PG backups, DNS/TLS, disk persistence) | No access | Production-like Docker environment (E3); INSTALL/UPGRADE/ROLLBACK runbook for humans | DevOps | Phase 1 |
| UV-11 | App Store / Play Store builds and review | Needs developer accounts | `tsc` + `expo export` build check | Mobile team | Phase 1 |
| UV-12 | Legal sufficiency for GST, e-invoicing, DPDP Act, UIDAI rules | QA is not legal or CA advice | Gap list against published rules (Phase 14) | Business + CA / legal counsel | Phase 1 |
| UV-13 | Usability with real cashiers/kitchen staff (SUS, task timings) | Needs real users | USABILITY script (Phase 15) | Product team | Phase 1 |
| UV-14 | Absolute production capacity | Laptop numbers are relative, not absolute | k6 results reported as relative; re-run on staging of production size | DevOps | Phase 1 |
| UV-15 | Web app behaviour in the user's dev setup (`apps/api/.env`, `apps/web/.env.local`) | Global rule: `.env` files are never read | QA uses explicit env vars from the `.env.example` dev fallbacks against a separate `canavo_qa` DB | Developer (self-check) | Phase 2 |
| UV-16 | Node 20 (minimum `engines`) and Node 22 (CI) locally | Local machine has Node 26.10 | CI runs Node 22; a Node 20 matrix job is proposed for Phase 16 | CI | Phase 2 |

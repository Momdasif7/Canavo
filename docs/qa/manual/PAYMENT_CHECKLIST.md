# Payment checklist (Razorpay test mode + plain UPI)

**Never use live keys.** Use a Razorpay account in **Test mode** (keys start with `rzp_test_`). Per-store keys are set
in **Settings → Integrations → Razorpay** (owner); the webhook URL to paste in Razorpay is shown on that card
(`{PUBLIC_API_URL}/webhooks/razorpay/<store key>`), events `qr_code.credited`, `refund.processed`, `refund.failed`.
Background: [DEPLOYMENT.md §2a](../../deployment/DEPLOYMENT.md) and [requests-rqa.md](../../build/requests-rqa.md).
The staging API must be reachable from the internet for webhooks (or use a tunnel).

Record: bill no., amount, Razorpay payment / QR / refund id, time paid, time the bill turned paid.

| # | Scenario | Steps | Expected | Result |
|---|---|---|---|---|
| P1 | No store keys | Integrations shows Razorpay "Not connected"; bill ₹30 → UPI | Plain UPI QR for the outlet VPA (canavo@okaxis); cashier taps **Received** | |
| P2 | Store keys saved | Enter test key ID / secret / webhook secret → Test connection | Connected; secrets shown as ••••last4 only | |
| P3 | UPI QR with a real UPI app | Bill ₹110 → UPI; scan with GPay/PhonePe/Paytm (Razorpay test QR: use the test UPI flow or "simulate payment" in the dashboard) | Webhook marks bill paid within ~10 s; receipt prints | |
| P4 | Two stores, two accounts | Store A and Store B each with own test keys; pay in both | Each payment appears only in its own Razorpay dashboard; refunds go back through the same account | |
| P5 | Wrong webhook secret | Change the secret on one side only; pay | Bill stays pending; webhook rejected (401) — cashier can confirm manually after checking the dashboard | |
| P6 | Rotated webhook key | Rotate in CANAVO, don't update Razorpay; pay | Old URL 401; after updating the URL, new payments confirm | |
| P7 | Partial payment | ₹245 bill: Cash ₹100 then UPI QR for ₹145 | QR amount is the remainder ₹145; bill paid only after both | |
| P8 | Split three ways | Cash + UPI + Card | Sum = total; each listed on the bill | |
| P9 | Full refund | Refund a paid UPI bill (owner/manager) | Credit note; Razorpay refund created; `refund.processed` webhook marks it done | |
| P10 | Partial refund | Refund ₹50 of ₹110 | Refund ₹50; remaining ₹60 not refundable twice | |
| P11 | Refund failure | In test mode force a failed refund (dashboard) | `refund.failed` → bill shows refund failed; manager can retry / pay cash | |
| P12 | Failed payment | Cancel the payment in the UPI app | Bill stays unpaid; cashier can retry or switch to cash; no paid status | |
| P13 | Pending / abandoned | Open QR, close dialog, never pay | Bill pending/unpaid; can reopen QR from Bills; QR expires per settings | |
| P14 | Webhook delay | Block outbound webhooks (tunnel off) 5 min, pay, re-enable | Bill turns paid when the webhook arrives (Razorpay retries); no double payment if cashier also tapped Received — check | |
| P15 | Duplicate webhook | Resend the same webhook event from the dashboard | Payment recorded once | |
| P16 | Online order UPI | Online page → UPI → pay | Order "UPI prepaid" on the staff screen | |
| P17 | Cinema seat UPI | Seat page → pay; webhook off → runner taps **UPI received** | Paid once | |
| P18 | Delivery COD | Partner collects COD | Counted in partner cash, not in UPI | |
| P19 | Shared platform account | `RAZORPAY_SHARED_ACCOUNT=true`, store without keys | Platform test account used; turned off → plain UPI | |
| P20 | Amount edge | ₹1 bill; ₹99,999 bill | QR amount exact to the paisa | |
| P21 | Day close | Cash drawer close + Reports payment split | UPI total = Razorpay dashboard captured total for the day | |

Tester: ________ Date: ______ Build: ______ Razorpay test account: ______

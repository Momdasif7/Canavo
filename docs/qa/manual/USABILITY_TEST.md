# Usability test script (5 real users)

**Goal:** find where real counter staff and owners hesitate, make errors or give up. 5 users find most problems.

## Participants
| P | Profile | Role to play | Device |
|---|---|---|---|
| P1 | Canteen cashier, uses a phone daily, never used CANAVO | Cashier | Android tablet POS |
| P2 | Restaurant cashier who has used another POS (Petpooja / similar) | Cashier | Laptop + touch |
| P3 | Cook / kitchen helper, basic smartphone use | Kitchen | KDS TV |
| P4 | Small-restaurant owner, 40+, uses WhatsApp and UPI | Owner | Laptop + phone |
| P5 | Delivery rider | Delivery partner | Own Android phone |

Recruit people who are not on the team. Offer a small thank-you. Get consent for screen + audio recording (no faces
needed). Language: let them think aloud in Hindi / Kannada / English as they prefer.

## Setup (moderator)
Staging, demo data, logins pre-typed on a card. Stopwatch / screen recorder. Reset the cart between tasks.
Say: *"We are testing the app, not you. Please think aloud. I can't help during a task."* Allow 3 min of free look.

## Tasks
| T | Task (read to the participant) | Who | Success criterion | Target time |
|---|---|---|---|---|
| T1 | "Bill this order: 2 masala chai, 1 samosa, 1 veg sandwich with extra cheese, 1 mango lassi. Customer pays ₹500 cash." | P1, P2 | Bill paid, total ₹180, change ₹320 | ≤ 60 s (first time), ≤ 30 s (repeat) |
| T2 | "Customer wants to pay half cash, half UPI." (₹180) | P1, P2 | Split recorded | ≤ 45 s |
| T3 | "Customer Priya (9845010001) wants to use her points." | P1, P2 | Points redeemed | ≤ 45 s |
| T4 | "Find out if table 3's food is ready." | P2 | Opens the bill drawer / kitchen status | ≤ 30 s |
| T5 | "Mark this order as being prepared, then ready." | P3 | Ticket bumped twice | ≤ 15 s |
| T6 | "Make samosas unavailable for today." | P4 | Item out of stock | ≤ 60 s |
| T7 | "How much did the shop sell yesterday, and how much by UPI?" | P4 | Correct numbers said aloud | ≤ 90 s |
| T8 | "Deliver only to PIN 560034 with a ₹30 fee." | P4 | Address mode saved with fee and area | ≤ 3 min |
| T9 | "Change the WhatsApp message used for receipts." | P4 | Finds WhatsApp templates and understands texts are edited in Meta | ≤ 3 min |
| T10 | "Pick up your next delivery, deliver it, and collect cash." | P5 | Status Delivered, COD recorded | ≤ 2 min (excluding travel) |
| T11 | "Order a chicken biryani (full) for pickup on this link." (online page, phone) | P1, P4 | Order placed | ≤ 2 min |

## Measures (per task)
| P | T | Time (s) | Success (Y / partial / N) | Errors (wrong taps, back-outs) | Assists | Ease 1–7 (single-ease question) | Quote / observation |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

**Error rate** = errors ÷ (tasks attempted). **Completion rate** per task. Flag any task with < 80 % success or median
time > 1.5 × target.

## SUS questionnaire (after all tasks; 1 = strongly disagree … 5 = strongly agree)
1. I think that I would like to use this system frequently.
2. I found the system unnecessarily complex.
3. I thought the system was easy to use.
4. I think that I would need the support of a technical person to be able to use this system.
5. I found the various functions in this system were well integrated.
6. I thought there was too much inconsistency in this system.
7. I would imagine that most people would learn to use this system very quickly.
8. I found the system very cumbersome to use.
9. I felt very confident using the system.
10. I needed to learn a lot of things before I could get going with this system.

**Score:** odd items (score − 1), even items (5 − score); sum × 2.5 → 0–100. Target **≥ 75** (good); < 68 is below average.

| P | Q1 | Q2 | Q3 | Q4 | Q5 | Q6 | Q7 | Q8 | Q9 | Q10 | SUS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P1 | | | | | | | | | | | |
| P2 | | | | | | | | | | | |
| P3 | | | | | | | | | | | |
| P4 | | | | | | | | | | | |
| P5 | | | | | | | | | | | |

## Observation notes
| Time | P | Screen | What happened (verbatim quote / action) | Severity (1 cosmetic … 4 blocker) | Suggested fix |
|---|---|---|---|---|---|
| | | | | | |

## Debrief questions
What was the hardest part? What would slow you down at lunch rush? Anything missing compared to what you use today?
Would you trust the totals? (Owner) Would you pay for this?

## Report
Top 5 problems with severity and frequency (n of 5), task table, SUS mean and range, recommendations. Raise P2/P3 bugs
for each problem with "Usability" in the title.

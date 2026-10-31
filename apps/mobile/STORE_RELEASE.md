# CANAVO mobile: store release checklist

Submitting needs your own **Google Play Console** account (one-time US$25) and **Apple Developer Program** membership (US$99/year). Nothing below has been submitted. This file lists the steps.

## 0. One-time project setup

```bash
cd apps/mobile
npm i -g eas-cli            # or use npx eas-cli
eas login
eas init                    # creates the EAS project and prints its id
```

- Put the project id in your environment as `EAS_PROJECT_ID` (shell, CI, or the EAS dashboard "Environment variables"). `app.config.ts` reads it into `extra.eas.projectId`. **Push notifications need it.** Without it, the app skips push registration (in-app notifications still work).
- Set the production API URL in `eas.json → build.production.env.EXPO_PUBLIC_API_URL`. The default is `https://api.canavo.in`.
- Identifiers: Android package and iOS bundle id are both `in.canavo.app`. Change them now if needed. **They can never change after the first upload.**

### Push credentials
- **Android (FCM v1):** create a Firebase project and add an Android app `in.canavo.app`. Then upload a service-account key with `eas credentials` → Android → Push Notifications (FCM V1). You don't need `google-services.json` for Expo push.
- **iOS (APNs):** `eas credentials` → iOS → Push Notifications. EAS can create the key for you.
- The API sends pushes through Expo's push service using the tokens the app registers at `POST /notifications/devices`.

## 1. Versioning

`eas.json` uses `"appVersionSource": "local"`, so the values in `app.config.ts` are what ships:

| Field | Where | Rule |
| --- | --- | --- |
| `VERSION` (e.g. `1.0.0`) | `app.config.ts` | User-visible version. Bump it for each release. |
| `BUILD` (integer) | `app.config.ts` | Becomes Android `versionCode` and iOS `buildNumber`. **Bump it for every store upload.** Both stores reject a number they have already seen. |

## 2. Build

```bash
eas build --platform android --profile production   # .aab (app bundle)
eas build --platform ios --profile production       # .ipa
```

EAS manages signing. Let it generate the Android upload keystore and back it up with `eas credentials`. Enrol in **Play App Signing** when Play Console asks.

## 3. Submit

```bash
# Android: needs a Play service-account JSON with "Release manager" access
#   saved at apps/mobile/secrets/play-service-account.json (git-ignored)
eas submit --platform android --profile production --latest

# iOS: fill appleId / ascAppId / appleTeamId in eas.json → submit.production.ios
eas submit --platform ios --profile production --latest
```

The Android submit profile uploads to the **internal** track as a **draft**. Promote it to closed/open testing or production in Play Console. **The first Android upload must be done by hand** in Play Console, because the API can't create the app.

## 4. Google Play Console

1. **Create app:** name "CANAVO", default language English (India), App, Free.
2. **App access:** the app is login-only (staff OTP). Give reviewers a demo phone number and OTP, or a test email and password, on a review/staging API.
3. **Ads:** none.
4. **Content rating:** IARC questionnaire, category "Business/Productivity", no user-generated content.
5. **Target audience:** 18+ (staff tool). Not designed for children.
6. **Data safety** (see the data table below):
   - Data is collected, encrypted in transit (HTTPS), and the user can request deletion through their employer or admin.
   - **Location (precise):** collected for app functionality (attendance geofence, delivery tracking). It is not shared with third parties and is not used for ads. Only collected while the app is in use.
   - **Personal info → Name, Phone number:** collected for account management and app functionality. This covers staff and the customers entered at the POS.
   - **Photos/videos:** none. The camera is used only to scan barcodes and no images are stored or sent.
   - **App activity / device IDs:** a push token and an install id (device attribution for sessions). Used for app functionality.
   - **Financial info:** purchase/bill amounts are business records. No card numbers are stored, and UPI payments go through the payment gateway.
7. **Permissions declarations:**
   - **Location:** foreground only. `ACCESS_BACKGROUND_LOCATION` is explicitly blocked in `app.config.ts`, so no background-location declaration is needed.
   - **Camera:** barcode scanning.
   - **Bluetooth:** thermal printers.
   - **Notifications:** `POST_NOTIFICATIONS` on Android 13+.
8. **Privacy policy URL:** required. Host it, for example at `https://canavo.in/privacy`. It must cover everything in section 6.
9. **Store listing:** short description (80 chars), full description, 512×512 icon (export `assets/icon.png` at 512), 1024×500 feature graphic, phone screenshots (2–8), and optionally 7"/10" tablet screenshots.

## 5. App Store Connect

1. **Create app:** iOS, bundle id `in.canavo.app`, SKU `canavo-ios`, name "CANAVO".
2. **App Privacy** ("nutrition label"). None of this is used for tracking:
   - **Contact Info → Name, Phone Number:** app functionality, linked to the user.
   - **Location → Precise Location:** app functionality, linked to the user.
   - **Identifiers → Device ID:** app functionality (push token / install id).
   - **Purchases / Financial:** none (business bill records aren't the user's purchases).
3. **Encryption:** `ITSAppUsesNonExemptEncryption = false` is set (`ios.config.usesNonExemptEncryption`). The app uses HTTPS only.
4. **Sign-in:** add a demo account in App Review Information. Reviewers can't receive an Indian OTP SMS, so give them a password login or a fixed review OTP on the review API.
5. **Usage strings** are already set in `app.config.ts`: location, camera, Face ID, Bluetooth.
6. **Screenshots:** 6.7" (1290×2796) and 6.5" (1242×2688) iPhone are required. Add 12.9" iPad (2048×2732) because `supportsTablet` is true. Set it to false if you won't ship tablet screenshots.
7. **Distribution:** TestFlight internal testing first, then submit for review.

## 6. Privacy-policy checklist (location, camera, phone numbers)

The policy must say, in plain language:

- **Location:**
  - collected when staff clock in or out (to check they are within the outlet geofence);
  - collected when a cashier taps "Use my location" to pin a delivery address;
  - collected every ~30 s **while a delivery agent has an order out for delivery and the app is open**, shared live with that outlet's managers;
  - live positions are kept in memory on the server only (not stored as history);
  - attendance stores the distance from the outlet.
- **Camera:** only used to read barcodes and QR codes. No photos are taken or uploaded.
- **Phone numbers:**
  - staff numbers are used for OTP login;
  - customer numbers are entered at the POS for loyalty points, khata (credit) and WhatsApp bills or reminders;
  - they are stored by the business, never sold, and sent only to the SMS/WhatsApp providers needed to deliver messages.
- **Notifications:** an Expo/FCM/APNs push token is stored to send work alerts (deliveries, low stock, leave).
- **Retention and deletion:** who to contact (the business admin) and how long attendance and bill records are kept (tax law requires invoices for 8 years in India).

## 7. Screenshots to capture

Use a seeded demo outlet, light mode, and a 1080×2400-class Android phone plus an iPhone 6.7":

1. Login (OTP)
2. Home: clock-in button with shift and today's KPIs
3. Bill: menu grid with offer chips and cart bar
4. Cart sheet: customer lookup (tier, points), coupon applied, server totals
5. Delivery order: address, zone fee, agent picker
6. Tables: floor with occupied/free colours and timers
7. Table tab: KOT rounds, "Bill" split options
8. Payment: UPI QR / equal split shares
9. Kitchen KOT board: table label, PRE-ORDER badge, voided line
10. My deliveries (agent): big status button and amount to collect
11. Inventory: low-stock list, barcode scanner, stock count screen
12. Reports: 7-day trend and outlets overview

## 8. Pre-flight

- [ ] `npx tsc --noEmit`, `npx expo-doctor`, `npx expo export --platform android` all pass
- [ ] Production `EXPO_PUBLIC_API_URL` is HTTPS and reachable
- [ ] `EAS_PROJECT_ID` is set, and FCM/APNs credentials are uploaded; a test push arrives on a real device
- [ ] `BUILD` is bumped
- [ ] Tested on a real Android device in a **development/preview build**: Bluetooth printer, barcode scan, delivery live location, push
- [ ] Privacy policy URL is live; Data safety and App Privacy forms are filled in
- [ ] Demo reviewer account works against the review API

## Known limits

- **Live delivery location is foreground-only.** It pauses when the app is backgrounded or the screen locks. Adding background tracking needs three things: `expo-task-manager` + `Location.startLocationUpdatesAsync`, removing `ACCESS_BACKGROUND_LOCATION` from `blockedPermissions`, and the Play "background location" declaration with a prominent in-app disclosure and a review video.
- **Bluetooth thermal printing** needs a development or production build. It is not available in Expo Go.

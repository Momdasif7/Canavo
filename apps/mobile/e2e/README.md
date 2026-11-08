# Maestro flows (device / emulator only)

Not run in CI yet: they need a dev-client build (`eas build --profile development`) on a real phone or an
emulator, a seeded API (`npm run seed`, demo password `Canavo@123`) and `EXPO_PUBLIC_API_URL` pointing at it.

    maestro test apps/mobile/e2e/            # all flows
    maestro test apps/mobile/e2e/02-pos-cash-bill.yaml

Item names (`Masala Dosa`) come from the seed menu; adjust if your seed differs. Flows that toggle the network
(`03`) or Bluetooth / location (`05`, `06`) use Android emulator commands and are manual steps on iOS.

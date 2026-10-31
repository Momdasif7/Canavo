#!/usr/bin/env bash
# Run CANAVO behind one port and share it with every device through ngrok.
#
#   ./scripts/share.sh            # start everything + ngrok, prints the public https link
#   ./scripts/share.sh --local    # same, without ngrok (other devices on your Wi-Fi use http://<your-ip>:8080)
#
# One-time setup: create a free account at https://dashboard.ngrok.com, copy your authtoken, then run
#   ngrok config add-authtoken <YOUR_TOKEN>
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOGS="$ROOT/.share-logs"
GATEWAY_PORT="${GATEWAY_PORT:-8080}"
mkdir -p "$LOGS"
LOCAL_ONLY=false
[[ "${1:-}" == "--local" ]] && LOCAL_ONLY=true

if ! $LOCAL_ONLY; then
  if ! command -v ngrok >/dev/null; then echo "ngrok is not installed: brew install ngrok"; exit 1; fi
  if ! ngrok config check >/dev/null 2>&1; then
    echo "ngrok needs your (free) authtoken once:"
    echo "  1. Sign up / log in at https://dashboard.ngrok.com"
    echo "  2. Copy the token from 'Your Authtoken'"
    echo "  3. Run: ngrok config add-authtoken <YOUR_TOKEN>"
    echo "Then run this script again. (Or use --local for devices on the same Wi-Fi.)"
    exit 1
  fi
fi

free_port() { lsof -ti "tcp:$1" -sTCP:LISTEN | xargs kill 2>/dev/null || true; }
cleanup() {
  echo; echo "Stopping CANAVO…"
  kill $(jobs -p) 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "▶ Database"
(cd "$ROOT" && docker compose up -d postgres >/dev/null)

# The web app must call the API on its own origin (/api) to work through one public URL.
BUILD_MARK="$ROOT/apps/web/.next/.canavo-api-base"
if [[ "$(cat "$BUILD_MARK" 2>/dev/null)" != "/api" ]]; then
  echo "▶ Building the web app for the gateway (one-time, ~1 min)"
  (cd "$ROOT" && NEXT_PUBLIC_API_URL=/api npm run build -w @canavo/web >"$LOGS/web-build.log" 2>&1) || { echo "Web build failed — see $LOGS/web-build.log"; exit 1; }
  echo "/api" >"$BUILD_MARK"
fi

free_port 4000; free_port 3001; free_port 3100; free_port "$GATEWAY_PORT"
echo "▶ API      → http://localhost:4000"
(cd "$ROOT/apps/api" && npx tsx --env-file="$ROOT/apps/api/.env" src/index.ts >"$LOGS/api.log" 2>&1) &
echo "▶ Web app  (internal :3100)"
(cd "$ROOT/apps/web" && npx next start -p 3100 -H 127.0.0.1 >"$LOGS/web.log" 2>&1) &
echo "▶ Gateway  → http://localhost:$GATEWAY_PORT and http://localhost:3001"
(GATEWAY_PORTS="$GATEWAY_PORT,3001" node "$ROOT/scripts/gateway.mjs" >"$LOGS/gateway.log" 2>&1) &

for _ in $(seq 1 90); do
  curl -sf "http://localhost:$GATEWAY_PORT/api/health" >/dev/null && curl -sf -o /dev/null "http://localhost:$GATEWAY_PORT/login" && break
  sleep 1
done
curl -sf "http://localhost:$GATEWAY_PORT/api/health" >/dev/null || { echo "CANAVO didn't start — see $LOGS/"; exit 1; }

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
echo
echo "✅ CANAVO is running"
echo "   This computer : http://localhost:$GATEWAY_PORT"
[[ -n "$LAN_IP" ]] && echo "   Same Wi-Fi    : http://$LAN_IP:$GATEWAY_PORT   (GPS clock-in needs the https ngrok link)"

if ! $LOCAL_ONLY; then
  free_port 4040
  ngrok http "$GATEWAY_PORT" --log=stdout >"$LOGS/ngrok.log" 2>&1 &
  URL=""
  for _ in $(seq 1 30); do
    URL="$(curl -s http://127.0.0.1:4040/api/tunnels | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const t=JSON.parse(s).tunnels.find(x=>x.public_url.startsWith("https"));process.stdout.write(t?t.public_url:"")}catch{}})')"
    [[ -n "$URL" ]] && break
    sleep 1
  done
  if [[ -n "$URL" ]]; then
    echo "   Any device    : $URL"
    echo "   Mobile app    : set EXPO_PUBLIC_API_URL=$URL/api"
  else
    echo "ngrok didn't report a URL — see $LOGS/ngrok.log"
  fi
fi
echo
echo "Logins: admin@ / owner@ / manager@ / cashier@ / kitchen@ / delivery@canavo.local — password Canavo@123"
echo "Press Ctrl+C to stop."
wait

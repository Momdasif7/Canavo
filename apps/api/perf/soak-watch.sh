#!/usr/bin/env bash
# Sample the API under load every INTERVAL seconds (default 30) until stopped, as CSV on stdout:
#   time, API RSS MB, heap used MB (from /metrics), event-loop lag p99 ms, open fds, DB connections (all / active), sockets
# Usage: API_PID=<pid> METRICS_TOKEN=… DB=canavo_perf perf/soak-watch.sh > soak.csv
set -u
INTERVAL=${INTERVAL:-30}
API=${API:-http://localhost:4200}
DB=${DB:-canavo_perf}
PSQL=${PSQL:-"psql -h localhost -p 5433 -U canavo -d postgres -Atc"}
echo "time,rss_mb,heap_used_mb,loop_lag_p99_ms,fds,db_conns,db_active,sockets"
while true; do
  rss=$(ps -o rss= -p "$API_PID" 2>/dev/null | awk '{printf "%.0f", $1/1024}')
  m=$(curl -s -H "authorization: Bearer ${METRICS_TOKEN}" "$API/metrics")
  heap=$(echo "$m" | awk '/^canavo_nodejs_heap_size_used_bytes /{printf "%.0f", $2/1048576}')
  lag=$(echo "$m" | awk '/^canavo_nodejs_eventloop_lag_p99_seconds /{printf "%.1f", $2*1000}')
  sockets=$(echo "$m" | awk 'index($0, "canavo_nodejs_active_handles{type=\"Socket\"} ") == 1 {print $2; exit}')
  fds=$(lsof -p "$API_PID" 2>/dev/null | wc -l | tr -d ' ')
  db=$(PGPASSWORD=${PGPASSWORD:-canavo} $PSQL "select count(*)||','||count(*) filter (where state='active') from pg_stat_activity where datname='$DB'")
  echo "$(date -u +%H:%M:%S),$rss,$heap,$lag,$fds,$db,${sockets:-}"
  sleep "$INTERVAL"
done

#!/bin/bash
# line-emitter.sh — deterministic stdout generator for S1 stress test
# Usage: ./line-emitter.sh <rate_lines_per_sec> <duration_sec> [emitter_id]
# Output format: SEQ=000001 EID=<id> T=<epoch_ms> DATA=<padding>
# Stderr on exit: "EMITTED: <total> lines"

set -euo pipefail

RATE="${1:-1000}"
DURATION="${2:-10}"
EID="${3:-0}"

if ! [[ "$RATE" =~ ^[0-9]+$ ]] || ! [[ "$DURATION" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 <rate_lines_per_sec> <duration_sec> [emitter_id]" >&2
  exit 1
fi

TOTAL=$((RATE * DURATION))
# Interval in nanoseconds between lines
INTERVAL_NS=$((1000000000 / RATE))
PADDING="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # 50 chars

# Use perl for microsecond-precision sleep and epoch_ms
SEQ=0
START_MS=$(perl -MTime::HiRes=time -e 'printf("%d\n", time()*1000)')
END_MS=$((START_MS + DURATION * 1000))

while true; do
  NOW_MS=$(perl -MTime::HiRes=time -e 'printf("%d\n", time()*1000)')
  [[ $NOW_MS -ge $END_MS ]] && break

  SEQ=$((SEQ + 1))
  printf "SEQ=%06d EID=%s T=%d DATA=%s\n" "$SEQ" "$EID" "$NOW_MS" "$PADDING"

  # Sleep only if we're ahead of schedule
  EXPECTED_MS=$((START_MS + (SEQ * 1000 / RATE)))
  DELTA_MS=$((EXPECTED_MS - NOW_MS))
  if [[ $DELTA_MS -gt 0 ]]; then
    perl -e "select(undef,undef,undef,$DELTA_MS/1000.0)"
  fi
done

echo "EMITTED: $SEQ lines (eid=$EID, rate=$RATE, duration=${DURATION}s)" >&2

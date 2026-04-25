#!/bin/bash
# audit-pii.sh — scan tracked files for personal information leaks.
# Run manually: ./scripts/audit-pii.sh
# Exits non-zero if any pattern matches, so it can be wired as a pre-push hook.
set -u

cd "$(git rev-parse --show-toplevel)"

# Patterns to guard against. Extend this list as new sensitive
# identifiers are added. Each entry: "<human label>|<regex>".
PATTERNS=(
  "Real name (Hangul)|김정환|정환김"
  "Real name (latin)|JEONGHWAN KIM|\bjeonghwan\b"
  "Personal email|jkeloper@|jkagement@|rhd8085@"
  "Apple cert SHA-1|F7FFAFFE1708D125A06AB4889FE0A9E4BE500A35|5C7B81521E6ADC5EA2CE2EC7E171CEBEF1CEDA6A"
  "Apple sub-team ids|QRHGU26ZZB|NFNFXJW4GR"
  "Host/machine name|jeonghwankimui|Macmini"
)

FAIL=0
FILES="$(git ls-files)"

for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"
  hits="$(printf '%s\n' "$FILES" | xargs -I{} grep -lE "$pattern" {} 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "❌ $label"
    printf '   %s\n' $hits
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "✓ audit-pii: no matches on $(echo "$FILES" | wc -l | tr -d ' ') tracked files"
fi

exit "$FAIL"

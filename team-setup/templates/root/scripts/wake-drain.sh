#!/usr/bin/env bash
# Drain the durable wake inbox and print a single agent instruction.
#
# Prints nothing and exits 1 when the inbox is empty, so a caller can do:
#
#   if followup=$(bash scripts/wake-drain.sh); then …; fi
#
# Draining moves each wake to consumed/ before printing, so a wake is handed
# to exactly one agent turn even if two hooks fire at once.
set -euo pipefail

WAKE_ROOT="${ROSETTA_WAKE_DIR:-$HOME/.rosetta/wake}"
WAKE_PENDING="$WAKE_ROOT/pending"
WAKE_CONSUMED="$WAKE_ROOT/consumed"

mkdir -p "$WAKE_PENDING" "$WAKE_CONSUMED"

shopt -s nullglob
pending=("$WAKE_PENDING"/*.json)
shopt -u nullglob

if [[ ${#pending[@]} -eq 0 ]]; then
  exit 1
fi

claimed=()
for file in "${pending[@]}"; do
  target="$WAKE_CONSUMED/$(basename "$file")"
  # mv is the claim: whichever drainer wins the rename owns the wake.
  if mv "$file" "$target" 2>/dev/null; then
    claimed+=("$target")
  fi
done

if [[ ${#claimed[@]} -eq 0 ]]; then
  exit 1
fi

python3 - "${claimed[@]}" <<'PY'
import json, sys

items = []
for path in sys.argv[1:]:
    try:
        with open(path) as handle:
            items.append(json.load(handle))
    except (OSError, json.JSONDecodeError):
        continue

if not items:
    sys.exit(1)

items.sort(key=lambda item: item.get("createdAt", ""))

lines = [
    f"{len(items)} background wake signal(s) fired while you were idle. "
    "Handle each one, then stop. Do not ask for confirmation first — these "
    "are the automated continuity signals you armed.",
    "",
]
for index, item in enumerate(items, start=1):
    lines.append(f"{index}. [{item.get('kind', 'unknown')}] {item.get('prompt', '').strip()}")
    data = item.get("data") or {}
    if data:
        lines.append(f"   context: {json.dumps(data, sort_keys=True)}")

print("\n".join(lines))
PY

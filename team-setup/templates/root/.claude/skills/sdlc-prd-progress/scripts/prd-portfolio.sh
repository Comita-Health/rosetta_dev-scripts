#!/usr/bin/env bash
# Inventory PRDs across the platform and consumer workspace: product status, specs,
# and sdlc-workflow runs — including idle / not-actively-worked items.
#
# Usage:
#   ROSETTA_WORKSPACE=~/projects/rosetta ./prd-portfolio.sh
#   PRD_PORTFOLIO_ALL=1 ./prd-portfolio.sh          # include Shipped/…
#   PRD_PORTFOLIO_STALE_HOURS=72 ./prd-portfolio.sh
#   PRD_PORTFOLIO_SCOPE=platform|consumer|all ./prd-portfolio.sh
set -euo pipefail

WORKSPACE="${ROSETTA_WORKSPACE:-$(pwd)}"
RUNS_DIR="${ROSETTA_SDLC_RUNS_DIR:-${HOME}/.rosetta/sdlc-runs}"
INCLUDE_TERMINAL="${PRD_PORTFOLIO_ALL:-0}"
STALE_HOURS="${PRD_PORTFOLIO_STALE_HOURS:-48}"
SCOPE="${PRD_PORTFOLIO_SCOPE:-all}" # platform | consumer | all

if [[ ! -d "$WORKSPACE" ]]; then
  echo "workspace not found: $WORKSPACE" >&2
  exit 1
fi

yaml_field() {
  local file="$1" key="$2"
  sed -n "1,25p" "$file" | sed -n "s/^${key}:[[:space:]]*//p" | head -1 \
    | sed 's/[[:space:]]*#.*//' | sed "s/^['\"]//;s/['\"]$//" | tr -d '\r'
}

path_in_scope() {
  local rel="$1"
  case "$SCOPE" in
    platform)
      [[ "$rel" == rosetta_* ]] || [[ "$rel" == */rosetta_* ]] || return 1
      ;;
    consumer)
      local repo_name="${rel%%/*}"
      [[ "$repo_name" == *_docs && "$repo_name" != "rosetta_docs" ]] || return 1
      ;;
    all) ;;
    *)
      echo "unknown PRD_PORTFOLIO_SCOPE=$SCOPE (use platform|consumer|all)" >&2
      exit 1
      ;;
  esac
  return 0
}

find_specs() {
  local id="$1"
  find "$WORKSPACE" \
    \( -path '*/node_modules/*' -o -path '*/.git/*' -o -path '*/dist/*' \) -prune -o \
    -type f -path "*/specs/${id}/*spec.md" -print 2>/dev/null | sort -u
}

find_runs() {
  local id="$1"
  local r
  [[ -d "$RUNS_DIR" ]] || return 0
  for r in "$RUNS_DIR"/*; do
    [[ -d "$r" && -f "$r/state.json" ]] || continue
    if grep -Eq "$id" "$r/state.json" 2>/dev/null; then
      echo "$r"
    fi
  done
}

run_summary() {
  local state="$1/state.json"
  local updated merged run_id age_h activity
  run_id=$(basename "$1")
  updated=$(python3 -c "import json;print(json.load(open('$state')).get('updatedAt',''))" 2>/dev/null || true)
  merged=$(python3 -c "import json;print((json.load(open('$state')).get('mergedSha') or '')[:12])" 2>/dev/null || true)
  age_h="?"
  if [[ -n "$updated" ]]; then
    age_h=$(python3 -c "
from datetime import datetime, timezone
u=datetime.fromisoformat('${updated}'.replace('Z','+00:00'))
print(int((datetime.now(timezone.utc)-u).total_seconds()//3600))
" 2>/dev/null || echo "?")
  fi
  activity="idle"
  if [[ "$age_h" != "?" ]] && [[ "$age_h" -lt "$STALE_HOURS" ]]; then
    activity="recent"
  fi
  if pgrep -f "run-id[= ]${run_id}|--run-id[= ]${run_id}" >/dev/null 2>&1; then
    activity="active-process"
  fi
  echo "${run_id}|${activity}|${age_h}h|tip=${merged:-none}|updated=${updated:-none}"
}

bucket_for() {
  local status="$1" sdlc_note="$2" spec_note="$3"
  if [[ "$sdlc_note" == *active-process* ]]; then
    echo "active"
  elif [[ "$sdlc_note" == *recent* ]]; then
    echo "warm"
  elif [[ "$sdlc_note" == *idle* ]] || [[ "$sdlc_note" == "no-run" ]]; then
    echo "parked"
  elif [[ "$spec_note" != "none" ]]; then
    echo "parked"
  elif [[ "$status" == "Proposed" || "$status" == "Draft" || "$status" == "Accepted" ]]; then
    echo "backlog"
  else
    echo "other"
  fi
}

echo "# PRD portfolio — ${WORKSPACE}"
echo "# scope=${SCOPE} · stale=${STALE_HOURS}h · INCLUDE_TERMINAL=${INCLUDE_TERMINAL}"
echo ""
printf '%-10s %-12s %-8s %-22s %s\n' "ID" "PRODUCT" "BUCKET" "IMPL/SPEC" "TITLE"
printf '%-10s %-12s %-8s %-22s %s\n' "----------" "------------" "--------" "----------------------" "-----"

count_active=0
count_warm=0
count_parked=0
count_backlog=0
count_other=0

# Collect paths first (portable; avoid mapfile / bash-4-only)
PRD_LIST=$(
  find "$WORKSPACE" \
    \( -path '*/node_modules/*' -o -path '*/.git/*' -o -path '*/dist/*' \) -prune -o \
    -type f -name 'PRD-*.md' -print 2>/dev/null \
    | grep -E '/(product|docs/product)/PRD-[0-9]+' \
    | grep -v TEMPLATE \
    | sort -u
)

while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  rel=${f#"$WORKSPACE/"}
  path_in_scope "$rel" || continue

  id=$(yaml_field "$f" id)
  title=$(yaml_field "$f" title)
  status=$(yaml_field "$f" status)
  [[ -n "$id" ]] || continue
  status="${status%%[[:space:]]*}"
  status="${status%%#*}"

  if [[ "$INCLUDE_TERMINAL" != "1" ]]; then
    case "$status" in
      Shipped|Deprecated|Superseded) continue ;;
    esac
  fi

  specs=$(find_specs "$id")
  spec_note="none"
  _last_spec_path=""
  if [[ -n "$specs" ]]; then
    spec_note=""
    while IFS= read -r sp; do
      [[ -z "$sp" ]] && continue
      ss=$(yaml_field "$sp" status)
      ss="${ss%%[[:space:]]*}"
      ss="${ss%%#*}"
      bn=$(basename "$(dirname "$sp")")/$(basename "$sp")
      if [[ -n "$spec_note" ]]; then
        spec_note="${spec_note};${ss}"
      else
        spec_note="$ss"
      fi
      _last_spec_path="$bn"
    done <<<"$specs"
  fi

  runs=$(find_runs "$id")
  sdlc_note="—"
  if [[ -n "$runs" ]]; then
    sdlc_note=""
    while IFS= read -r rd; do
      [[ -z "$rd" ]] && continue
      rs=$(run_summary "$rd")
      if [[ -n "$sdlc_note" ]]; then
        sdlc_note="${sdlc_note};${rs}"
      else
        sdlc_note="$rs"
      fi
    done <<<"$runs"
  elif [[ "$spec_note" != "none" ]]; then
    sdlc_note="no-run"
  fi

  bucket=$(bucket_for "$status" "$sdlc_note" "$spec_note")
  case "$bucket" in
    active) count_active=$((count_active + 1)) ;;
    warm) count_warm=$((count_warm + 1)) ;;
    parked) count_parked=$((count_parked + 1)) ;;
    backlog) count_backlog=$((count_backlog + 1)) ;;
    *) count_other=$((count_other + 1)) ;;
  esac

  printf '%-10s %-12s %-8s %-22s %s\n' "$id" "$status" "$bucket" "${spec_note:0:22}" "$title"
  printf '           path: %s\n' "$rel"
  if [[ "$spec_note" != "none" && -n "${_last_spec_path:-}" ]]; then
    printf '           spec: %s\n' "$_last_spec_path"
  fi
  if [[ "$sdlc_note" != "—" && "$sdlc_note" != "no-run" ]]; then
    printf '           sdlc: %s\n' "$sdlc_note"
  elif [[ "$sdlc_note" == "no-run" ]]; then
    printf '           sdlc: no run yet (spec exists — parked)\n'
  fi
done <<<"$PRD_LIST"

echo ""
echo "## Counts"
echo "  active=${count_active}  warm=${count_warm}  parked=${count_parked}  backlog=${count_backlog}  other=${count_other}"

echo ""
echo "## Open docs PRs that may add PRDs (not yet on default branch)"
seen_repos="|"
for repo_dir in "$WORKSPACE"/rosetta_docs "$WORKSPACE"/*_docs; do
  [[ -d "$repo_dir/.git" ]] || continue
  case "$seen_repos" in
    *"|$repo_dir|"*) continue ;;
  esac
  seen_repos="${seen_repos}${repo_dir}|"
  base=$(basename "$repo_dir")
  case "$SCOPE" in
    platform) [[ "$base" == rosetta_* ]] || continue ;;
    consumer) [[ "$base" == *_docs && "$base" != "rosetta_docs" ]] || continue ;;
  esac
  remote=$(git -C "$repo_dir" remote get-url origin 2>/dev/null || true)
  [[ -n "$remote" ]] || continue
  slug=$(echo "$remote" | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$#\1#')
  [[ "$slug" == */* ]] || continue
  echo "### $slug"
  gh pr list -R "$slug" --search 'PRD in:title' --state open --limit 20 \
    --json number,title,headRefName,url 2>/dev/null \
    | python3 -c "
import json,sys
rows=json.load(sys.stdin)
if not rows:
  print('  (none)')
for r in rows:
  print(f\"  #{r['number']}  {r['title']}\")
  print(f\"         {r['url']}\")
" 2>/dev/null || echo "  (gh unavailable)"
done

echo ""
echo "## Legend"
echo "  backlog  — Draft/Proposed/Accepted product PRD, no implementation run/spec"
echo "  parked   — Spec and/or run exists, but no recent activity / no live process"
echo "  warm     — Run updated within ${STALE_HOURS}h"
echo "  active   — Live sdlc-workflow process for this run"
echo "  other    — Non-default product status without run activity"
echo ""
echo "Tip: PRD_PORTFOLIO_ALL=1 includes Shipped/Deprecated/Superseded."
echo "     PRD_PORTFOLIO_SCOPE=platform|consumer|all filters product families."
echo "     Do not confuse consumer PRD-NNNN with Rosetta PRD-NNNN (different products / namespaces)."

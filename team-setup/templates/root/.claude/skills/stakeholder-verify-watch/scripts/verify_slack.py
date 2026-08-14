#!/usr/bin/env python3
"""Slack Sandbox-verify list: publish markdown checkboxes and watch status.

Bret checks Verified/Failed here (no GitHub). PHI-free rows only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

SLACK_API = "https://slack.com/api"


def die(message: str, code: int = 2) -> None:
    print(f"stakeholder-verify: {message}", file=sys.stderr)
    raise SystemExit(code)


def slack_post(method: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{SLACK_API}/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        die(f"{method} HTTP {err.code}: {err.read()[:500]!r}")
    if body.get("ok") is not True:
        die(f"{method} failed: {body.get('error', body)}")
    return body


def host_from_text(text: str, default: str) -> str:
    lowered = text.lower()
    found: list[tuple[int, str]] = []
    for name in ("admit.dev", "care.dev", "contracts.dev"):
        idx = lowered.find(name)
        if idx >= 0:
            found.append((idx, name))
    if found:
        return min(found)[1]
    if " prod" in lowered or lowered.startswith("prod"):
        return "prod"
    return default


def parse_not_verified(markdown: str) -> list[dict[str, str]]:
    """Extract `- [ ]` smoke lines from the Not verified section."""
    lines = markdown.splitlines()
    in_section = False
    items: list[dict[str, str]] = []
    pending: list[str] = []
    current_host = "admit.dev"

    def flush() -> None:
        if not pending:
            return
        text = " ".join(part.strip() for part in pending if part.strip())
        pending.clear()
        if not text:
            return
        items.append({"item": text, "host": host_from_text(text, current_host)})

    for raw in lines:
        stripped = raw.strip()
        if stripped.startswith("### Not verified"):
            in_section = True
            continue
        if in_section and (
            stripped.startswith("### Verified") or stripped.startswith("## ")
        ):
            flush()
            break
        if in_section is False:
            continue
        if not stripped.startswith("- ["):
            current_host = host_from_text(stripped, current_host)
        if stripped.startswith("- [ ]"):
            flush()
            pending.append(stripped[len("- [ ]") :].strip())
        elif pending and stripped.startswith("- [x]"):
            flush()
        elif pending and raw[:1].isspace() and not stripped.startswith("- "):
            pending.append(stripped)
        elif stripped.startswith("- [x]"):
            continue
    flush()
    return items


def require_env() -> tuple[str, str]:
    token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    list_id = os.environ.get("COMITA_VERIFY_SLACK_LIST_ID", "").strip()
    if not token:
        die("SLACK_BOT_TOKEN is unset (eval slack-activate.sh)")
    if not list_id:
        die(
            "COMITA_VERIFY_SLACK_LIST_ID is unset. Create the Slack list "
            "once, put the id in ~/.config/comita/slack.env, retry."
        )
    return token, list_id


def col_map() -> dict[str, str]:
    """Optional explicit column ids; otherwise use names the list must match."""
    return {
        "item": os.environ.get("COMITA_VERIFY_COL_ITEM", "Item"),
        "host": os.environ.get("COMITA_VERIFY_COL_HOST", "Host"),
        "status": os.environ.get("COMITA_VERIFY_COL_STATUS", "Status"),
        "ship": os.environ.get("COMITA_VERIFY_COL_SHIP", "Ship"),
        "notes": os.environ.get("COMITA_VERIFY_COL_NOTES", "Notes"),
    }


def cmd_parse(args: argparse.Namespace) -> None:
    text = Path(args.file).read_text(encoding="utf-8")
    rows = parse_not_verified(text)
    json.dump({"ship": args.ship, "count": len(rows), "items": rows}, sys.stdout, indent=2)
    sys.stdout.write("\n")


def cmd_publish(args: argparse.Namespace) -> None:
    text = Path(args.file).read_text(encoding="utf-8")
    rows = parse_not_verified(text)
    print(f"stakeholder-verify: {len(rows)} Not-verified line(s) in {args.file}")
    for row in rows:
        print(f"  [{row['host']}] {row['item']}")
    if args.dry_run:
        return
    token, list_id = require_env()
    # List schema + upsert: create when Item text is new. Slack Lists API
    # field shape is column_id + typed value; we send a minimal record and
    # let the list's default Status be Not verified.
    existing = slack_post(
        "slackLists.items.list",
        token,
        {"list_id": list_id, "limit": 200},
    )
    known: set[str] = set()
    for entry in existing.get("items", existing.get("records", [])):
        fields = entry.get("fields") or entry.get("columns") or {}
        if isinstance(fields, dict):
            for value in fields.values():
                if isinstance(value, str) and value.strip():
                    known.add(value.strip())
    cols = col_map()
    created = 0
    for row in rows:
        if row["item"] in known:
            continue
        slack_post(
            "slackLists.items.create",
            token,
            {
                "list_id": list_id,
                "initial_fields": [
                    {"key": cols["item"], "value": row["item"]},
                    {"key": cols["host"], "value": row["host"]},
                    {"key": cols["status"], "value": "Not verified"},
                    {"key": cols["ship"], "value": args.ship},
                ],
            },
        )
        created += 1
    print(f"stakeholder-verify: created {created}, already present {len(rows) - created}")


def item_status(entry: dict[str, Any]) -> tuple[str, str, str]:
    """Return (item_text, status_lower, notes)."""
    fields = entry.get("fields") or entry.get("columns") or {}
    item = ""
    status = ""
    notes = ""
    if isinstance(fields, dict):
        for key, value in fields.items():
            text = value if isinstance(value, str) else json.dumps(value)
            key_l = str(key).lower()
            if "status" in key_l:
                status = text
            elif "note" in key_l:
                notes = text
            elif "item" in key_l or "title" in key_l or not item:
                if "host" not in key_l and "ship" not in key_l:
                    item = text
    return item.strip(), status.strip().lower(), notes.strip()


def cmd_watch(args: argparse.Namespace) -> None:
    token, list_id = require_env()
    state_path = Path(
        args.state
        or os.path.join(
            os.environ.get("TMPDIR", "/tmp"),
            f"comita-verify-{list_id}.json",
        )
    )
    prior: dict[str, str] = {}
    if state_path.exists():
        prior = json.loads(state_path.read_text(encoding="utf-8"))
    if args.kickoff:
        print(
            'AGENT_LOOP_WAKE_stakeholder_verify '
            + json.dumps({"signal": "kickoff", "list_id": list_id}),
            flush=True,
        )
    while True:
        data = slack_post(
            "slackLists.items.list",
            token,
            {"list_id": list_id, "limit": 200},
        )
        current: dict[str, str] = {}
        for entry in data.get("items", data.get("records", [])):
            item, status, notes = item_status(entry)
            if not item:
                continue
            current[item] = status
            old = prior.get(item, "")
            if status == old:
                continue
            if status in {"verified", "done"}:
                print(
                    "AGENT_LOOP_WAKE_stakeholder_verify "
                    + json.dumps(
                        {"signal": "verified", "item": item, "notes": notes}
                    ),
                    flush=True,
                )
            elif status in {"failed", "fail", "blocked"}:
                print(
                    "AGENT_LOOP_WAKE_stakeholder_verify "
                    + json.dumps(
                        {"signal": "failed", "item": item, "notes": notes}
                    ),
                    flush=True,
                )
        state_path.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
        prior = current
        if args.once:
            return
        time.sleep(max(5, args.interval))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_parse = sub.add_parser("parse", help="Print Not-verified rows as JSON")
    p_parse.add_argument("--file", required=True)
    p_parse.add_argument("--ship", default="")
    p_parse.set_defaults(func=cmd_parse)

    p_pub = sub.add_parser("publish", help="Upsert Not-verified rows to Slack")
    p_pub.add_argument("--file", required=True)
    p_pub.add_argument("--ship", required=True)
    p_pub.add_argument("--dry-run", action="store_true")
    p_pub.set_defaults(func=cmd_publish)

    p_watch = sub.add_parser("watch", help="Poll Slack and emit wake lines")
    p_watch.add_argument("--interval", type=int, default=30)
    p_watch.add_argument("--state", default="")
    p_watch.add_argument("--kickoff", action="store_true")
    p_watch.add_argument("--once", action="store_true")
    p_watch.set_defaults(func=cmd_watch)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

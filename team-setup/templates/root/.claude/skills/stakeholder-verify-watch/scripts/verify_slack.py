#!/usr/bin/env python3
"""Slack Sandbox-verify list: publish, status, failed-notify, promote snapshot.

Slack Status is the live check-off ledger. Git is written at publish and
again at promote. Do not poll Slack from a laptop. PHI-free rows only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

SLACK_API = "https://slack.com/api"
GITHUB_API = "https://api.github.com"
SANDBOX_HOSTS = ("admit.dev", "care.dev", "contracts.dev")
FAILED_STATUSES = frozenset({"failed", "fail", "blocked"})
VERIFIED_STATUSES = frozenset({"verified", "done"})
PENDING_STATUSES = frozenset({"not_verified", "not verified", ""})


def die(message: str, code: int = 2) -> None:
    print(f"sandbox-verify: {message}", file=sys.stderr)
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


def gh_request(
    method: str,
    path: str,
    token: str,
    payload: dict[str, Any] | None = None,
) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{GITHUB_API}{path}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json; charset=utf-8",
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as err:
        die(f"github {method} {path} HTTP {err.code}: {err.read()[:500]!r}")
    return json.loads(raw) if raw else None


def host_from_text(text: str, default: str) -> str:
    lowered = text.lower()
    found: list[tuple[int, str]] = []
    for name in SANDBOX_HOSTS:
        idx = lowered.find(name)
        if idx >= 0:
            found.append((idx, name))
    if found:
        return min(found)[1]
    if " prod" in lowered or lowered.startswith("prod"):
        return "prod"
    return default


def parse_not_verified(markdown: str) -> list[dict[str, str]]:
    """Extract `- [ ]` smoke lines from the Not verified / Verify section."""
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
        if stripped.startswith("### Not verified") or stripped.startswith(
            "## Verify"
        ):
            in_section = True
            continue
        if in_section and (
            stripped.startswith("### Verified")
            or (
                stripped.startswith("## ")
                and not stripped.startswith("## Verify")
            )
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
        die("SLACK_BOT_TOKEN is unset")
    if not list_id:
        die(
            "COMITA_VERIFY_SLACK_LIST_ID is unset. Create the Slack list "
            "once, put the id in ~/.config/comita/slack.env and GitHub vars."
        )
    return token, list_id


def require_github() -> tuple[str, str]:
    token = (
        os.environ.get("GH_TOKEN", "").strip()
        or os.environ.get("GITHUB_TOKEN", "").strip()
    )
    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not token:
        die("GH_TOKEN / GITHUB_TOKEN is unset")
    if not repo or "/" not in repo:
        die("GITHUB_REPOSITORY must be owner/repo")
    return token, repo


def col_map() -> dict[str, str]:
    """Column ids from env; display names only as a last-resort fallback."""
    return {
        "item": os.environ.get("COMITA_VERIFY_COL_ITEM", "Item"),
        "host": os.environ.get("COMITA_VERIFY_COL_HOST", "Host"),
        "status": os.environ.get("COMITA_VERIFY_COL_STATUS", "Status"),
        "ship": os.environ.get("COMITA_VERIFY_COL_SHIP", "Ship"),
        "notes": os.environ.get("COMITA_VERIFY_COL_NOTES", "Notes"),
    }


def rich_text(text: str) -> list[dict[str, Any]]:
    """Slack Lists text cells take a rich_text block, not a plain string."""
    return [
        {
            "type": "rich_text",
            "elements": [
                {
                    "type": "rich_text_section",
                    "elements": [{"type": "text", "text": text}],
                }
            ],
        }
    ]


def item_fields(
    cols: dict[str, str],
    *,
    item: str,
    host: str,
    ship: str,
    status: str = "not_verified",
) -> list[dict[str, Any]]:
    """initial_fields for slackLists.items.create (column_id + typed values)."""
    fields: list[dict[str, Any]] = [
        {"column_id": cols["item"], "rich_text": rich_text(item)},
        {"column_id": cols["host"], "select": [host]},
        {"column_id": cols["status"], "select": [status]},
    ]
    if ship:
        fields.append({"column_id": cols["ship"], "rich_text": rich_text(ship)})
    return fields


def field_text(field: dict[str, Any]) -> str:
    """Best-effort display text from a Slack Lists field object."""
    text = field.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    val = field.get("value")
    if isinstance(val, str) and val.strip():
        return val.strip()
    if isinstance(val, dict):
        for key in ("text", "name", "label", "value"):
            inner = val.get(key)
            if isinstance(inner, str) and inner.strip():
                return inner.strip()
    select = field.get("select")
    if isinstance(select, str) and select.strip():
        return select.strip()
    if isinstance(select, list) and select:
        first = select[0]
        if isinstance(first, str) and first.strip():
            return first.strip()
        if isinstance(first, dict):
            for key in ("name", "label", "value", "text"):
                inner = first.get(key)
                if isinstance(inner, str) and inner.strip():
                    return inner.strip()
    return ""


def flatten_fields(entry: dict[str, Any]) -> dict[str, str]:
    """Map Slack field key/column_id (lowercased) to display text."""
    raw = entry.get("fields") or entry.get("columns") or []
    out: dict[str, str] = {}
    if isinstance(raw, dict):
        for key, value in raw.items():
            text = value if isinstance(value, str) else field_text({"value": value})
            if text:
                out[str(key).lower()] = text
        return out
    if isinstance(raw, list):
        for field in raw:
            if not isinstance(field, dict):
                continue
            text = field_text(field)
            if not text:
                continue
            for key in (field.get("key"), field.get("column_id")):
                if key:
                    out[str(key).lower()] = text
    return out


def pick_field(flat: dict[str, str], *names: str) -> str:
    for name in names:
        if not name:
            continue
        hit = flat.get(name.lower())
        if hit:
            return hit
        for key, value in flat.items():
            if name.lower() in key:
                return value
    return ""


def item_status(entry: dict[str, Any]) -> tuple[str, str, str]:
    """Return (item_text, status_lower, notes)."""
    row = item_row(entry)
    return row["item"], row["status"], row["notes"]


def item_row(entry: dict[str, Any]) -> dict[str, str]:
    cols = col_map()
    flat = flatten_fields(entry)
    item = pick_field(flat, cols["item"], "name", "item", "title").strip()
    status = pick_field(flat, cols["status"], "status").strip().lower()
    notes = pick_field(flat, cols["notes"], "notes", "note").strip()
    ship = pick_field(flat, cols["ship"], "ship").strip()
    host = pick_field(flat, cols["host"], "host").strip().lower()
    return {
        "item": item,
        "status": status,
        "notes": notes,
        "ship": ship,
        "host": host,
    }


def list_rows(token: str, list_id: str) -> list[dict[str, str]]:
    data = slack_post(
        "slackLists.items.list",
        token,
        {"list_id": list_id, "limit": 200},
    )
    rows: list[dict[str, str]] = []
    for entry in data.get("items", data.get("records", [])):
        row = item_row(entry)
        if row["item"]:
            rows.append(row)
    return rows


def normalize_item(text: str) -> str:
    return " ".join(text.split())


def ship_issue(ship: str) -> str | None:
    match = re.search(r"(\d+)", ship)
    return match.group(1) if match else None


def failed_comment_key(ship: str, item: str) -> str:
    digest = hashlib.sha256(f"{ship}\n{item}".encode("utf-8")).hexdigest()[:16]
    return digest


def failed_marker(key: str) -> str:
    return f"<!-- sandbox-verify-failed:{key} -->"


def failed_comment_body(row: dict[str, str]) -> str:
    ship = ship_issue(row["ship"]) or row["ship"] or "unknown"
    key = failed_comment_key(ship, row["item"])
    notes_line = f"\n\nNotes: {row['notes']}" if row["notes"] else ""
    host = row["host"] or "unknown host"
    return (
        f"{failed_marker(key)}\n"
        f"Sandbox verify **Failed** on `{host}` (ship #{ship}).\n\n"
        f"{row['item']}{notes_line}\n\n"
        "Do not promote. Fix, redeploy, set Slack Status back to Not verified."
    )


def check_off_verified(markdown: str, verified_texts: set[str]) -> str:
    """Flip `- [ ]` to `- [x]` when the smoke line matches a Slack Verified item."""
    normalized = {normalize_item(text) for text in verified_texts}
    if not normalized:
        return markdown
    lines = markdown.splitlines(keepends=True)
    pending_idxs: list[int] = []
    pending_parts: list[str] = []
    in_section = False

    def flush() -> None:
        nonlocal pending_idxs, pending_parts
        if not pending_idxs:
            pending_parts = []
            return
        text = " ".join(part.strip() for part in pending_parts if part.strip())
        if normalize_item(text) in normalized:
            idx = pending_idxs[0]
            lines[idx] = lines[idx].replace("- [ ]", "- [x]", 1)
        pending_idxs = []
        pending_parts = []

    for i, raw in enumerate(lines):
        stripped = raw.strip()
        if stripped.startswith("### Not verified") or stripped.startswith(
            "## Verify"
        ):
            in_section = True
            continue
        if in_section and (
            stripped.startswith("### Verified")
            or (
                stripped.startswith("## ")
                and not stripped.startswith("## Verify")
            )
        ):
            flush()
            break
        if in_section is False:
            continue
        if stripped.startswith("- [ ]"):
            flush()
            pending_idxs = [i]
            pending_parts = [stripped[len("- [ ]") :].strip()]
        elif pending_idxs and stripped.startswith("- ["):
            flush()
        elif pending_idxs and raw[:1].isspace() and not stripped.startswith("- "):
            pending_idxs.append(i)
            pending_parts.append(stripped)
    flush()
    return "".join(lines)


def cmd_parse(args: argparse.Namespace) -> None:
    text = Path(args.file).read_text(encoding="utf-8")
    rows = parse_not_verified(text)
    json.dump(
        {"ship": args.ship, "count": len(rows), "items": rows},
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")


def cmd_publish(args: argparse.Namespace) -> None:
    text = Path(args.file).read_text(encoding="utf-8")
    rows = parse_not_verified(text)
    print(f"sandbox-verify: {len(rows)} Not-verified line(s) in {args.file}")
    for row in rows:
        print(f"  [{row['host']}] {row['item']}")
    if args.dry_run:
        return
    token, list_id = require_env()
    existing = list_rows(token, list_id)
    known = {(normalize_item(row["item"]), row["host"]) for row in existing}
    cols = col_map()
    created = 0
    for row in rows:
        key = (normalize_item(row["item"]), row["host"])
        if key in known:
            continue
        slack_post(
            "slackLists.items.create",
            token,
            {
                "list_id": list_id,
                "initial_fields": item_fields(
                    cols,
                    item=row["item"],
                    host=row["host"],
                    ship=args.ship,
                ),
            },
        )
        created += 1
        known.add(key)
    print(
        f"sandbox-verify: created {created}, already present {len(rows) - created}"
    )


def cmd_status(args: argparse.Namespace) -> None:
    token, list_id = require_env()
    rows = list_rows(token, list_id)
    json.dump({"count": len(rows), "items": rows}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    if args.fail_on_pending:
        pending = [
            row
            for row in rows
            if row["host"] in SANDBOX_HOSTS
            and row["status"] not in VERIFIED_STATUSES
        ]
        if pending:
            die(f"{len(pending)} sandbox row(s) are not Verified", 1)


def cmd_failed_notify(args: argparse.Namespace) -> None:
    token, list_id = require_env()
    gh_token, repo = require_github()
    rows = list_rows(token, list_id)
    failed = [row for row in rows if row["status"] in FAILED_STATUSES]
    owner, name = repo.split("/", 1)
    commented = 0
    skipped = 0
    for row in failed:
        issue = ship_issue(row["ship"])
        if not issue:
            print(
                f"sandbox-verify: skip failed row with no ship: {row['item'][:80]}",
                file=sys.stderr,
            )
            skipped += 1
            continue
        marker = failed_marker(failed_comment_key(issue, row["item"]))
        comments = gh_request(
            "GET",
            f"/repos/{owner}/{name}/issues/{issue}/comments?per_page=100",
            gh_token,
        )
        bodies = [
            str(comment.get("body") or "")
            for comment in comments or []
            if isinstance(comment, dict)
        ]
        if any(marker in body for body in bodies):
            skipped += 1
            continue
        if args.dry_run:
            print(f"sandbox-verify: would comment #{issue}: {row['item'][:80]}")
            commented += 1
            continue
        gh_request(
            "POST",
            f"/repos/{owner}/{name}/issues/{issue}/comments",
            gh_token,
            {"body": failed_comment_body(row)},
        )
        print(f"sandbox-verify: commented #{issue} for failed item")
        commented += 1
    print(f"sandbox-verify: failed-notify commented {commented}, skipped {skipped}")


def release_files(releases_dir: Path) -> list[Path]:
    files = sorted(releases_dir.glob("20*.md"))
    return [path for path in files if path.name.lower() != "readme.md"]


def cmd_snapshot(args: argparse.Namespace) -> None:
    token, list_id = require_env()
    rows = list_rows(token, list_id)
    verified = {
        row["item"] for row in rows if row["status"] in VERIFIED_STATUSES
    }
    pending = [
        row
        for row in rows
        if row["host"] in SANDBOX_HOSTS
        and row["status"] not in VERIFIED_STATUSES
    ]
    if args.require_sandbox_verified and pending:
        for row in pending:
            print(
                f"  still {row['status'] or 'unknown'} [{row['host']}] {row['item']}",
                file=sys.stderr,
            )
        die(f"{len(pending)} sandbox row(s) are not Verified", 1)

    releases_dir = Path(args.releases_dir)
    changed = 0
    for path in release_files(releases_dir):
        original = path.read_text(encoding="utf-8")
        updated = check_off_verified(original, verified)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            changed += 1
            print(f"sandbox-verify: snapshot updated {path}")
    print(f"sandbox-verify: snapshot files changed {changed}")

    if args.upsert_prod:
        cols = col_map()
        known = {(normalize_item(row["item"]), row["host"]) for row in rows}
        created = 0
        for row in rows:
            if row["status"] not in VERIFIED_STATUSES:
                continue
            if row["host"] == "prod":
                continue
            key = (normalize_item(row["item"]), "prod")
            if key in known:
                continue
            slack_post(
                "slackLists.items.create",
                token,
                {
                    "list_id": list_id,
                    "initial_fields": item_fields(
                        cols,
                        item=row["item"],
                        host="prod",
                        ship=row["ship"],
                    ),
                },
            )
            known.add(key)
            created += 1
        print(f"sandbox-verify: upserted {created} prod row(s)")


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

    p_status = sub.add_parser("status", help="Print live Slack rows as JSON")
    p_status.add_argument(
        "--fail-on-pending",
        action="store_true",
        help="Exit 1 if any sandbox host row is not Verified",
    )
    p_status.set_defaults(func=cmd_status)

    p_fail = sub.add_parser(
        "failed-notify",
        help="Comment Ship issues for new Slack Failed rows (GHA)",
    )
    p_fail.add_argument("--dry-run", action="store_true")
    p_fail.set_defaults(func=cmd_failed_notify)

    p_snap = sub.add_parser(
        "snapshot",
        help="Check off git release lines from Slack Verified (promote)",
    )
    p_snap.add_argument("--releases-dir", default="docs/releases")
    p_snap.add_argument(
        "--require-sandbox-verified",
        action="store_true",
        help="Fail if any admit.dev/care.dev/contracts.dev row is not Verified",
    )
    p_snap.add_argument(
        "--upsert-prod",
        action="store_true",
        help="Create prod host copies of Verified sandbox rows",
    )
    p_snap.set_defaults(func=cmd_snapshot)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

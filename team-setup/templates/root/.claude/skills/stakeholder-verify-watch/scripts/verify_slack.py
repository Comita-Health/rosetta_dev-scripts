#!/usr/bin/env python3
"""Sandbox-verify check-off: publish, status, failed-notify, promote snapshot.

Each sandbox drop gets **one thread** in #comita-support: a root message
naming the release date, ship, host and SHA, then one reply per smoke line.
The stakeholder reacts on a reply -- :white_check_mark: verified, :x: failed.
Reactions are the live ledger; git is written at publish and again at promote.

This replaces the Slack Lists ("Sandbox verify" list) model, which needed a
paid Slack plan. Threads, replies and reactions are free.

A later workflow run re-finds a drop's thread by scanning channel history for
the root message's marker (`sv:<release-stem>:<ship>`), so nothing has to be
committed back to the branch from CI. Do not poll Slack from a laptop.
PHI-free rows only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

SLACK_API = "https://slack.com/api"
GITHUB_API = "https://api.github.com"
SANDBOX_HOSTS = ("admit.dev", "care.dev", "contracts.dev")
# Public channel the bot already joins. Override with
# COMITA_VERIFY_NOTIFY_CHANNEL_ID (id or #name).
DEFAULT_NOTIFY_CHANNEL = "#comita-support"

VERIFIED_REACTIONS = frozenset(
    {"white_check_mark", "heavy_check_mark", "ballot_box_with_check"}
)
FAILED_REACTIONS = frozenset(
    {"x", "negative_squared_cross_mark", "no_entry", "no_entry_sign"}
)

STATUS_VERIFIED = "verified"
STATUS_FAILED = "failed"
STATUS_PENDING = "not_verified"

# How many pages of channel history to scan looking for drop roots. Slack
# caps `limit` at 200; 10 pages is roughly a quarter of #comita-support.
MAX_HISTORY_PAGES = 10

# Slack rate-limits chat.postMessage to about one call per second.
POST_INTERVAL_SECONDS = 1.1


def die(message: str, code: int = 2) -> None:
    print(f"sandbox-verify: {message}", file=sys.stderr)
    raise SystemExit(code)


def slack_call(
    method: str, token: str, payload: dict[str, Any]
) -> dict[str, Any]:
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


# Back-compat alias: the old name is still the one used in docs and tests.
slack_post = slack_call


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


# Release notes settled on `## Not verified` (H2) on 2026-08-22; the two files
# older than that use `### Not verified`, and a handful use `## Verify on ...`.
# Accept all three. `## Verified` must NOT match -- that is the section end.
NOT_VERIFIED_HEADING_RE = re.compile(
    r"^#{2,3}\s+(?:not\s+verified|verify)(?:\s+.*)?$", re.I
)
VERIFIED_HEADING_RE = re.compile(r"^#{2,3}\s+verified\s*$", re.I)


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
        if NOT_VERIFIED_HEADING_RE.match(stripped):
            in_section = True
            continue
        if in_section and stripped.startswith("#"):
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


def require_slack() -> str:
    token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
    if not token:
        die("SLACK_BOT_TOKEN is unset")
    return token


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


def normalize_item(text: str) -> str:
    return " ".join(text.split())


def match_key(text: str) -> str:
    """Compare smoke lines across markdown and Slack mrkdwn renderings.

    The same line is written `**bold**` in git and `*bold*` in Slack, so
    emphasis and code punctuation are stripped before comparing. Never use
    this for display -- it is lossy on purpose.
    """
    stripped = re.sub(r"[*_`~]+", "", text)
    stripped = stripped.replace("\u2192", "->")
    return " ".join(stripped.split()).strip().lower()


def to_mrkdwn(text: str) -> str:
    """Render a markdown smoke line the way Slack expects it."""
    return re.sub(r"\*\*(.+?)\*\*", r"*\1*", text)


def ship_issue(ship: str) -> str | None:
    match = re.search(r"(\d+)", ship or "")
    return match.group(1) if match else None


def failed_comment_key(ship: str, item: str) -> str:
    return hashlib.sha256(f"{ship}\n{item}".encode("utf-8")).hexdigest()[:16]


def failed_marker(key: str) -> str:
    return f"<!-- sandbox-verify-failed:{key} -->"


def failed_comment_body(row: dict[str, str]) -> str:
    ship = ship_issue(row.get("ship", "")) or row.get("ship") or "unknown"
    key = failed_comment_key(ship, row["item"])
    host = row.get("host") or "unknown host"
    link = row.get("permalink") or ""
    link_line = f"\n\n{link}" if link else ""
    return (
        f"{failed_marker(key)}\n"
        f"Sandbox verify **Failed** on `{host}` (ship #{ship}).\n\n"
        f"{row['item']}{link_line}\n\n"
        "Do not promote. Fix, redeploy, then clear the :x: reaction."
    )


# ---------------------------------------------------------------------------
# Slack thread model
# ---------------------------------------------------------------------------


def notify_channel() -> str:
    """#comita-support unless COMITA_VERIFY_NOTIFY_CHANNEL_ID is set."""
    return (
        os.environ.get("COMITA_VERIFY_NOTIFY_CHANNEL_ID", "").strip()
        or DEFAULT_NOTIFY_CHANNEL
    )


def resolve_channel(token: str, channel: str) -> str:
    """Accept a channel id or #name; history/replies need the id."""
    if not channel.startswith("#"):
        return channel
    wanted = channel[1:].strip().lower()
    cursor = ""
    for _ in range(MAX_HISTORY_PAGES):
        payload: dict[str, Any] = {
            "limit": 200,
            "exclude_archived": True,
            "types": "public_channel,private_channel",
        }
        if cursor:
            payload["cursor"] = cursor
        body = slack_call("conversations.list", token, payload)
        for entry in body.get("channels") or []:
            if str(entry.get("name", "")).lower() == wanted:
                return str(entry.get("id"))
        cursor = (body.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            break
    die(f"could not resolve channel {channel}")
    raise AssertionError("unreachable")


def release_stem(path: str | Path) -> str:
    return Path(path).stem


def thread_marker(stem: str, ship: str) -> str:
    """Stable key used to re-find a drop's root message in channel history."""
    return f"sv:{stem}:{ship}".strip()


MARKER_RE = re.compile(r"sv:([0-9A-Za-z._\-]+):(\d*)")


def root_message_text(
    *,
    stem: str,
    ship: str,
    host: str,
    sha: str = "",
    title: str = "",
    count: int = 0,
) -> str:
    ship_label = (ship or "").strip()
    if ship_label and not ship_label.startswith("#"):
        ship_label = f"#{ship_label}"
    noun = "line" if count == 1 else "lines"
    head = f"<!channel> *Sandbox verify — {stem}*"
    if ship_label:
        head += f"  (ship {ship_label})"
    lines = [head]
    detail = " ".join(part for part in (f"`{sha[:7]}`" if sha else "", title) if part)
    lines.append(f"{host} is live" + (f" on {detail}" if detail else ""))
    lines.append("")
    lines.append(
        f"{count} {noun} to smoke below — react on each one: "
        ":white_check_mark: verified, :x: failed."
    )
    lines.append("")
    lines.append(f"`{thread_marker(stem, ship)}`")
    return "\n".join(lines)


def find_root(
    token: str, channel: str, marker: str
) -> dict[str, Any] | None:
    """Locate a drop's root message by its marker, newest history first."""
    needle = marker.lower()
    cursor = ""
    for _ in range(MAX_HISTORY_PAGES):
        payload: dict[str, Any] = {"channel": channel, "limit": 200}
        if cursor:
            payload["cursor"] = cursor
        body = slack_call("conversations.history", token, payload)
        for msg in body.get("messages") or []:
            if needle in str(msg.get("text", "")).lower():
                return msg
        if not body.get("has_more"):
            return None
        cursor = (body.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            return None
    return None


def find_all_roots(token: str, channel: str) -> list[dict[str, Any]]:
    """Every sandbox-verify root message in recent channel history."""
    roots: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(MAX_HISTORY_PAGES):
        payload: dict[str, Any] = {"channel": channel, "limit": 200}
        if cursor:
            payload["cursor"] = cursor
        body = slack_call("conversations.history", token, payload)
        for msg in body.get("messages") or []:
            if MARKER_RE.search(str(msg.get("text", ""))):
                roots.append(msg)
        if not body.get("has_more"):
            break
        cursor = (body.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            break
    return roots


def thread_replies(
    token: str, channel: str, thread_ts: str
) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    cursor = ""
    for _ in range(MAX_HISTORY_PAGES):
        payload: dict[str, Any] = {
            "channel": channel,
            "ts": thread_ts,
            "limit": 200,
        }
        if cursor:
            payload["cursor"] = cursor
        body = slack_call("conversations.replies", token, payload)
        messages.extend(body.get("messages") or [])
        if not body.get("has_more"):
            break
        cursor = (body.get("response_metadata") or {}).get("next_cursor", "")
        if not cursor:
            break
    # The first message is the root itself.
    return [m for m in messages if str(m.get("ts")) != str(thread_ts)]


def reaction_status(message: dict[str, Any]) -> str:
    """Failed wins over verified so a re-smoke never silently promotes."""
    names = {
        str(r.get("name", "")).split("::", 1)[0]
        for r in message.get("reactions") or []
    }
    if names & FAILED_REACTIONS:
        return STATUS_FAILED
    if names & VERIFIED_REACTIONS:
        return STATUS_VERIFIED
    return STATUS_PENDING


def row_from_reply(
    message: dict[str, Any], *, stem: str, ship: str
) -> dict[str, str]:
    item = normalize_item(str(message.get("text", "")))
    return {
        "item": item,
        "status": reaction_status(message),
        "host": host_from_text(item, "admit.dev"),
        "ship": ship,
        "stem": stem,
        "ts": str(message.get("ts", "")),
        "permalink": str(message.get("permalink", "")),
    }


def read_thread_rows(
    token: str, channel: str, root: dict[str, Any]
) -> list[dict[str, str]]:
    match = MARKER_RE.search(str(root.get("text", "")))
    stem = match.group(1) if match else ""
    ship = match.group(2) if match else ""
    replies = thread_replies(token, channel, str(root.get("ts")))
    return [row_from_reply(m, stem=stem, ship=ship) for m in replies]


def read_all_rows(token: str, channel: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for root in find_all_roots(token, channel):
        rows.extend(read_thread_rows(token, channel, root))
    return rows


# ---------------------------------------------------------------------------
# Release-note rewriting (promote snapshot)
# ---------------------------------------------------------------------------

PLACEHOLDER_RE = re.compile(r"^_\(.*none yet.*\)_\s*$", re.I)


def check_off_verified(markdown: str, verified_texts: set[str]) -> str:
    """Flip `- [ ]` to `- [x]` when the smoke line was reacted verified."""
    normalized = {match_key(text) for text in verified_texts}
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
        if match_key(text) in normalized:
            idx = pending_idxs[0]
            lines[idx] = lines[idx].replace("- [ ]", "- [x]", 1)
        pending_idxs = []
        pending_parts = []

    for i, raw in enumerate(lines):
        stripped = raw.strip()
        if NOT_VERIFIED_HEADING_RE.match(stripped):
            in_section = True
            continue
        if in_section and stripped.startswith("#"):
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


def _heading_index(lines: list[str], pattern: re.Pattern[str]) -> int | None:
    for i, raw in enumerate(lines):
        if pattern.match(raw.strip()):
            return i
    return None


def _checkbox_blocks(
    lines: list[str], start: int, end: int
) -> list[dict[str, Any]]:
    """Checkbox items between start (inclusive) and end (exclusive)."""
    blocks: list[dict[str, Any]] = []
    pending_idxs: list[int] = []
    pending_parts: list[str] = []

    def flush() -> None:
        nonlocal pending_idxs, pending_parts
        if not pending_idxs:
            pending_parts = []
            return
        text = " ".join(part.strip() for part in pending_parts if part.strip())
        blocks.append(
            {
                "idxs": list(pending_idxs),
                "text": text,
                "lines": [lines[i] for i in pending_idxs],
            }
        )
        pending_idxs = []
        pending_parts = []

    for i in range(start, end):
        raw = lines[i]
        stripped = raw.strip()
        if stripped.startswith("- [ ]") or stripped.startswith("- [x]"):
            flush()
            pending_idxs = [i]
            if stripped.startswith("- [x]"):
                body = stripped[len("- [x]") :].strip()
            else:
                body = stripped[len("- [ ]") :].strip()
            pending_parts = [body]
        elif pending_idxs and stripped.startswith("- ["):
            flush()
        elif (
            pending_idxs
            and raw[:1].isspace()
            and not stripped.startswith("- ")
        ):
            pending_idxs.append(i)
            pending_parts.append(stripped)
        elif pending_idxs and stripped.startswith("#"):
            flush()
    flush()
    return blocks


def move_verified_lines(markdown: str, verified_texts: set[str]) -> str:
    """Move reacted-verified smoke lines into Verified. Never delete a line."""
    normalized = {match_key(text) for text in verified_texts}
    if not normalized:
        return markdown
    lines = markdown.splitlines(keepends=True)
    not_idx = _heading_index(lines, NOT_VERIFIED_HEADING_RE)
    verified_idx = _heading_index(lines, VERIFIED_HEADING_RE)
    if not_idx is None or verified_idx is None or verified_idx <= not_idx:
        return check_off_verified(markdown, verified_texts)

    heading_level = len(lines[verified_idx]) - len(
        lines[verified_idx].lstrip("#")
    )
    after_idx = len(lines)
    for i in range(verified_idx + 1, len(lines)):
        stripped = lines[i].strip()
        if not stripped.startswith("#"):
            continue
        level = len(stripped) - len(stripped.lstrip("#"))
        if level <= heading_level:
            after_idx = i
            break

    blocks = _checkbox_blocks(lines, not_idx + 1, verified_idx)
    move_idxs: set[int] = set()
    moved_lines: list[str] = []
    for block in blocks:
        if match_key(block["text"]) not in normalized:
            continue
        first = block["lines"][0].replace("- [ ]", "- [x]", 1)
        moved_lines.append(first if first.endswith("\n") else first + "\n")
        for extra in block["lines"][1:]:
            moved_lines.append(extra if extra.endswith("\n") else extra + "\n")
        move_idxs.update(block["idxs"])

    if not moved_lines:
        return markdown

    keep_verified: list[str] = []
    for raw in lines[verified_idx + 1 : after_idx]:
        if PLACEHOLDER_RE.match(raw.strip()):
            continue
        keep_verified.append(raw)
    while keep_verified and keep_verified[0].strip() == "":
        keep_verified.pop(0)
    while keep_verified and keep_verified[-1].strip() == "":
        keep_verified.pop()

    heading = lines[verified_idx]
    if not heading.endswith("\n"):
        heading += "\n"
    new_verified = [heading, "\n"]
    if keep_verified:
        new_verified.extend(keep_verified)
        if not new_verified[-1].endswith("\n"):
            new_verified[-1] += "\n"
        new_verified.append("\n")
    new_verified.extend(moved_lines)
    if not new_verified[-1].endswith("\n"):
        new_verified[-1] += "\n"

    rebuilt: list[str] = []
    rebuilt.extend(lines[: not_idx + 1])
    for i in range(not_idx + 1, verified_idx):
        if i not in move_idxs:
            rebuilt.append(lines[i])
    rebuilt.extend(new_verified)
    if after_idx < len(lines):
        if rebuilt and rebuilt[-1].strip() != "" and lines[after_idx].strip():
            rebuilt.append("\n")
        rebuilt.extend(lines[after_idx:])
    result = "".join(rebuilt)
    if markdown.endswith("\n") and not result.endswith("\n"):
        result += "\n"
    return result


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


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
    stem = release_stem(args.file)
    print(f"sandbox-verify: {len(rows)} Not-verified line(s) in {args.file}")
    for row in rows:
        print(f"  [{row['host']}] {row['item']}")
    if args.dry_run:
        return
    if not rows:
        print("sandbox-verify: nothing to publish")
        return

    token = require_slack()
    channel = resolve_channel(token, notify_channel())
    marker = thread_marker(stem, args.ship)
    root = find_root(token, channel, marker)

    if root is None:
        host = rows[0]["host"] if rows else "admit.dev"
        body = slack_call(
            "chat.postMessage",
            token,
            {
                "channel": channel,
                "text": root_message_text(
                    stem=stem,
                    ship=args.ship,
                    host=host,
                    sha=str(getattr(args, "sha", "") or ""),
                    title=str(getattr(args, "title", "") or ""),
                    count=len(rows),
                ),
                "unfurl_links": False,
                "unfurl_media": False,
            },
        )
        thread_ts = str(body.get("ts"))
        print(f"sandbox-verify: opened thread {thread_ts} in {channel}")
        existing_keys: set[str] = set()
    else:
        thread_ts = str(root.get("ts"))
        print(f"sandbox-verify: reusing thread {thread_ts} in {channel}")
        existing_keys = {
            match_key(row["item"])
            for row in read_thread_rows(token, channel, root)
        }

    posted = 0
    for row in rows:
        if match_key(row["item"]) in existing_keys:
            continue
        slack_call(
            "chat.postMessage",
            token,
            {
                "channel": channel,
                "thread_ts": thread_ts,
                "text": to_mrkdwn(row["item"]),
                "unfurl_links": False,
                "unfurl_media": False,
            },
        )
        existing_keys.add(match_key(row["item"]))
        posted += 1
        time.sleep(POST_INTERVAL_SECONDS)

    print(
        f"sandbox-verify: posted {posted}, already present {len(rows) - posted}"
    )

    if posted == 0 and root is not None:
        sha = str(getattr(args, "sha", "") or "")
        title = str(getattr(args, "title", "") or "")
        detail = " ".join(
            part for part in (f"`{sha[:7]}`" if sha else "", title) if part
        )
        slack_call(
            "chat.postMessage",
            token,
            {
                "channel": channel,
                "thread_ts": thread_ts,
                "text": "Redeployed"
                + (f" on {detail}" if detail else "")
                + " — same smoke lines, please re-check.",
                "unfurl_links": False,
                "unfurl_media": False,
            },
        )
        print("sandbox-verify: noted redeploy in thread (no channel ping)")


def cmd_status(args: argparse.Namespace) -> None:
    token = require_slack()
    channel = resolve_channel(token, notify_channel())
    if args.file:
        stem = release_stem(args.file)
        marker = thread_marker(stem, args.ship)
        root = find_root(token, channel, marker)
        rows = read_thread_rows(token, channel, root) if root else []
    else:
        rows = read_all_rows(token, channel)
    json.dump({"count": len(rows), "items": rows}, sys.stdout, indent=2)
    sys.stdout.write("\n")
    if args.fail_on_pending:
        pending = [
            row
            for row in rows
            if row["host"] in SANDBOX_HOSTS
            and row["status"] != STATUS_VERIFIED
        ]
        if pending:
            die(f"{len(pending)} sandbox row(s) are not verified", 1)


def cmd_failed_notify(args: argparse.Namespace) -> None:
    token = require_slack()
    gh_token, repo = require_github()
    channel = resolve_channel(token, notify_channel())
    rows = read_all_rows(token, channel)
    failed = [row for row in rows if row["status"] == STATUS_FAILED]
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
    token = require_slack()
    channel = resolve_channel(token, notify_channel())
    rows = read_all_rows(token, channel)
    verified = {row["item"] for row in rows if row["status"] == STATUS_VERIFIED}
    pending = [
        row
        for row in rows
        if row["host"] in SANDBOX_HOSTS and row["status"] != STATUS_VERIFIED
    ]
    if args.require_sandbox_verified and pending:
        for row in pending:
            print(
                f"  still {row['status']} [{row['host']}] {row['item']}",
                file=sys.stderr,
            )
        die(f"{len(pending)} sandbox row(s) are not verified", 1)

    releases_dir = Path(args.releases_dir)
    changed = 0
    for path in release_files(releases_dir):
        original = path.read_text(encoding="utf-8")
        updated = move_verified_lines(original, verified)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            changed += 1
            print(f"sandbox-verify: snapshot updated {path}")
    print(f"sandbox-verify: snapshot files changed {changed}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_parse = sub.add_parser("parse", help="Print Not-verified rows as JSON")
    p_parse.add_argument("--file", required=True)
    p_parse.add_argument("--ship", default="")
    p_parse.set_defaults(func=cmd_parse)

    p_pub = sub.add_parser(
        "publish", help="Post a drop's smoke lines as a Slack thread"
    )
    p_pub.add_argument("--file", required=True)
    p_pub.add_argument("--ship", required=True)
    p_pub.add_argument("--dry-run", action="store_true")
    p_pub.add_argument("--sha", default="", help="Deployed git SHA")
    p_pub.add_argument(
        "--title", default="", help="PHI-free commit subject for the root message"
    )
    p_pub.set_defaults(func=cmd_publish)

    p_status = sub.add_parser("status", help="Print live thread rows as JSON")
    p_status.add_argument(
        "--file", default="", help="Limit to one release note's thread"
    )
    p_status.add_argument("--ship", default="")
    p_status.add_argument(
        "--fail-on-pending",
        action="store_true",
        help="Exit 1 if any sandbox host row is not verified",
    )
    p_status.set_defaults(func=cmd_status)

    p_fail = sub.add_parser(
        "failed-notify",
        help="Comment Ship issues for new :x: reactions (GHA)",
    )
    p_fail.add_argument("--dry-run", action="store_true")
    p_fail.set_defaults(func=cmd_failed_notify)

    p_snap = sub.add_parser(
        "snapshot",
        help="Check off git release lines from :white_check_mark: (promote)",
    )
    p_snap.add_argument("--releases-dir", default="docs/releases")
    p_snap.add_argument(
        "--require-sandbox-verified",
        action="store_true",
        help="Fail if any admit.dev/care.dev/contracts.dev row is not verified",
    )
    p_snap.set_defaults(func=cmd_snapshot)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

from pathlib import Path
import importlib.util
import os
import unittest

HELPER = Path(__file__).resolve().parents[1] / "verify_slack.py"


def load_mod():
    spec = importlib.util.spec_from_file_location("verify_slack", HELPER)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SAMPLE = """
## Verify on admit.dev

### Not verified

**New this morning** (admit.dev):

- [ ] Uploaded referral PDFs show viewer-local date/time next to the
      filename.
- [ ] Care case dialog: type `@` in Messages — picker + pills.

**New this morning** (care.dev / contracts.dev):

- [ ] Awaiting-billing building stays in the Care picker on care.dev.

### Verified

- [x] Already done item should not publish.
"""

# The shape every release note has used since 2026-08-22.
H2_SAMPLE = """
# 2026-09-07 — Why while Run Comita is reading

## Delivered

- Something shipped.

## Not verified

- [ ] Start Run Comita. While the message says Reading the packet,
      **View Review →** opens Review Summary.
- [ ] A second Run Comita posts a new top-level letter, not a reply.

## Verified

## Out

- Changing the finished compact card layout
"""


class ParseNotVerifiedTests(unittest.TestCase):
    def test_extracts_unchecked_lines_and_skips_verified(self):
        mod = load_mod()
        rows = mod.parse_not_verified(SAMPLE)
        texts = [row["item"] for row in rows]
        self.assertEqual(len(rows), 3)
        self.assertIn("filename.", texts[0])
        self.assertEqual(rows[0]["host"], "admit.dev")
        self.assertTrue(any("picker + pills" in t for t in texts))
        self.assertTrue(any(row["host"] == "care.dev" for row in rows))
        self.assertFalse(any("Already done" in t for t in texts))

    def test_h2_not_verified_heading_is_parsed(self):
        """Regression: an H2 heading silently published nothing for weeks."""
        mod = load_mod()
        rows = mod.parse_not_verified(H2_SAMPLE)
        self.assertEqual(len(rows), 2)
        self.assertIn("View Review", rows[0]["item"])
        self.assertIn("top-level letter", rows[1]["item"])

    def test_verified_heading_ends_the_section(self):
        mod = load_mod()
        rows = mod.parse_not_verified(H2_SAMPLE)
        self.assertFalse(any("compact card" in row["item"] for row in rows))

    def test_parse_verify_heading_without_not_verified_section(self):
        mod = load_mod()
        markdown = """
## Verify on admit.dev

- [ ] Care hop orgs on admit.dev.
- [ ] Contracts hop.

## Out of this ship

- [ ] Should not publish.
"""
        rows = mod.parse_not_verified(markdown)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["host"], "admit.dev")
        self.assertFalse(any("Should not" in row["item"] for row in rows))


class MatchKeyTests(unittest.TestCase):
    def test_markdown_and_slack_emphasis_compare_equal(self):
        mod = load_mod()
        git_line = "Click **View Review →** and the `Why` opens."
        slack_line = "Click *View Review ->* and the Why opens."
        self.assertEqual(mod.match_key(git_line), mod.match_key(slack_line))

    def test_to_mrkdwn_converts_bold(self):
        mod = load_mod()
        self.assertEqual(mod.to_mrkdwn("a **b** c"), "a *b* c")


class ReactionStatusTests(unittest.TestCase):
    def test_no_reaction_is_pending(self):
        mod = load_mod()
        self.assertEqual(mod.reaction_status({}), mod.STATUS_PENDING)

    def test_check_mark_is_verified(self):
        mod = load_mod()
        msg = {"reactions": [{"name": "white_check_mark", "count": 1}]}
        self.assertEqual(mod.reaction_status(msg), mod.STATUS_VERIFIED)

    def test_x_beats_check_mark(self):
        """A re-smoke that failed must never promote on a stale check."""
        mod = load_mod()
        msg = {
            "reactions": [
                {"name": "white_check_mark", "count": 1},
                {"name": "x", "count": 1},
            ]
        }
        self.assertEqual(mod.reaction_status(msg), mod.STATUS_FAILED)

    def test_skin_tone_suffix_is_ignored(self):
        mod = load_mod()
        msg = {"reactions": [{"name": "white_check_mark::skin-tone-3"}]}
        self.assertEqual(mod.reaction_status(msg), mod.STATUS_VERIFIED)


class ThreadMarkerTests(unittest.TestCase):
    def test_root_message_has_channel_ping_and_marker(self):
        mod = load_mod()
        text = mod.root_message_text(
            stem="2026-09-07",
            ship="706",
            host="admit.dev",
            sha="3c563cc5eb444ffde3597897f4c07842bb6b93f4",
            title="feat: Why mid-run",
            count=3,
        )
        self.assertIn("<!channel>", text)
        self.assertIn("ship #706", text)
        self.assertIn("3c563cc", text)
        self.assertIn("`sv:2026-09-07:706`", text)
        self.assertIn("3 lines to smoke", text)

    def test_marker_round_trips_through_regex(self):
        mod = load_mod()
        marker = mod.thread_marker("2026-09-07", "706")
        found = mod.MARKER_RE.search(f"blah `{marker}` blah")
        assert found is not None
        self.assertEqual(found.group(1), "2026-09-07")
        self.assertEqual(found.group(2), "706")

    def test_release_stem_drops_directory_and_suffix(self):
        mod = load_mod()
        self.assertEqual(
            mod.release_stem("docs/releases/2026-09-07.md"), "2026-09-07"
        )


class FakeSlack:
    """Minimal stand-in for the Slack Web API used by publish."""

    def __init__(self, root=None, replies=None):
        self.calls: list[tuple[str, dict]] = []
        self.root = root
        self.replies = replies or []

    def __call__(self, method, token, payload):
        self.calls.append((method, payload))
        if method == "conversations.history":
            msgs = [self.root] if self.root else []
            return {"ok": True, "messages": msgs, "has_more": False}
        if method == "conversations.replies":
            root_ts = str(payload.get("ts"))
            return {
                "ok": True,
                "messages": [{"ts": root_ts}] + self.replies,
                "has_more": False,
            }
        if method == "chat.postMessage":
            return {"ok": True, "ts": "1725000000.000100"}
        return {"ok": True}

    def posts(self):
        return [p for m, p in self.calls if m == "chat.postMessage"]


class PublishThreadTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_mod()
        self._env = {
            "SLACK_BOT_TOKEN": os.environ.get("SLACK_BOT_TOKEN"),
            "COMITA_VERIFY_NOTIFY_CHANNEL_ID": os.environ.get(
                "COMITA_VERIFY_NOTIFY_CHANNEL_ID"
            ),
        }
        os.environ["SLACK_BOT_TOKEN"] = "xoxb-test"
        os.environ["COMITA_VERIFY_NOTIFY_CHANNEL_ID"] = "C123"
        self.mod.POST_INTERVAL_SECONDS = 0

    def tearDown(self):
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _write(self, tmp: Path) -> str:
        path = tmp / "2026-09-07.md"
        path.write_text(H2_SAMPLE, encoding="utf-8")
        return str(path)

    def _args(self, file_path):
        import argparse

        return argparse.Namespace(
            file=file_path,
            ship="706",
            dry_run=False,
            sha="3c563cc5eb44",
            title="feat: Why mid-run",
        )

    def test_opens_thread_and_posts_one_reply_per_line(self):
        import tempfile

        fake = FakeSlack()
        self.mod.slack_call = fake
        with tempfile.TemporaryDirectory() as tmp:
            self.mod.cmd_publish(self._args(self._write(Path(tmp))))
        posts = fake.posts()
        self.assertEqual(len(posts), 3)  # root + 2 smoke lines
        self.assertIn("<!channel>", posts[0]["text"])
        self.assertNotIn("thread_ts", posts[0])
        self.assertTrue(all("thread_ts" in p for p in posts[1:]))
        self.assertIn("View Review", posts[1]["text"])
        # markdown bold is rendered as Slack bold
        self.assertIn("*View Review", posts[1]["text"])
        self.assertNotIn("**View Review", posts[1]["text"])

    def test_rerun_reuses_thread_and_does_not_repost(self):
        import tempfile

        root = {
            "ts": "1725000000.000001",
            "text": "Sandbox verify — 2026-09-07 `sv:2026-09-07:706`",
        }
        replies = [
            {
                "ts": "1725000000.000002",
                "text": (
                    "Start Run Comita. While the message says Reading the "
                    "packet, *View Review ->* opens Review Summary."
                ),
            },
            {
                "ts": "1725000000.000003",
                "text": "A second Run Comita posts a new top-level letter, not a reply.",
            },
        ]
        fake = FakeSlack(root=root, replies=replies)
        self.mod.slack_call = fake
        with tempfile.TemporaryDirectory() as tmp:
            self.mod.cmd_publish(self._args(self._write(Path(tmp))))
        posts = fake.posts()
        # No new root, no duplicated smoke lines -- just the redeploy note.
        self.assertEqual(len(posts), 1)
        self.assertIn("Redeployed", posts[0]["text"])
        self.assertNotIn("<!channel>", posts[0]["text"])
        self.assertIn("thread_ts", posts[0])

    def test_dry_run_makes_no_slack_calls(self):
        import tempfile

        fake = FakeSlack()
        self.mod.slack_call = fake
        args = self._args("")
        with tempfile.TemporaryDirectory() as tmp:
            args.file = self._write(Path(tmp))
            args.dry_run = True
            self.mod.cmd_publish(args)
        self.assertEqual(fake.calls, [])


class SnapshotAndFailedTests(unittest.TestCase):
    def test_check_off_verified_flips_matching_checkbox(self):
        mod = load_mod()
        markdown = (
            "## Verify on admit.dev\n\n"
            "- [ ] Care hop orgs on admit.dev.\n"
            "- [ ] Contracts hop.\n\n"
            "## Out of this ship\n"
        )
        updated = mod.check_off_verified(
            markdown, {"Care hop orgs on admit.dev."}
        )
        self.assertIn("- [x] Care hop orgs on admit.dev.", updated)
        self.assertIn("- [ ] Contracts hop.", updated)

    def test_move_verified_lines_into_verified_section(self):
        mod = load_mod()
        markdown = (
            "### Not verified\n\n"
            "- [ ] Care hop orgs on admit.dev.\n"
            "- [ ] Uploaded referral PDFs show viewer-local date/time next to the\n"
            "      filename.\n\n"
            "### Verified\n\n"
            "_(none yet — move a line here when Bret confirms)_\n\n"
            "## Out of this ship\n"
        )
        updated = mod.move_verified_lines(
            markdown,
            {"Care hop orgs on admit.dev."},
        )
        self.assertNotIn(
            "- [ ] Care hop orgs on admit.dev.",
            updated.split("### Verified")[0],
        )
        verified = updated.split("### Verified", 1)[1]
        self.assertIn("- [x] Care hop orgs on admit.dev.", verified)
        self.assertIn("- [ ] Uploaded referral PDFs", updated)
        self.assertNotIn("none yet", updated)
        self.assertIn("## Out of this ship", updated)

    def test_move_verified_lines_with_h2_headings(self):
        mod = load_mod()
        markdown = (
            "## Not verified\n\n"
            "- [ ] Care hop orgs on admit.dev.\n"
            "- [ ] Contracts hop.\n\n"
            "## Verified\n\n"
            "## Out\n\n"
            "- Nope.\n"
        )
        updated = mod.move_verified_lines(
            markdown, {"Care hop orgs on admit.dev."}
        )
        before, after = updated.split("## Verified", 1)
        self.assertNotIn("- [ ] Care hop orgs", before)
        self.assertIn("- [x] Care hop orgs on admit.dev.", after)
        self.assertIn("- [ ] Contracts hop.", before)
        self.assertIn("## Out", updated)

    def test_move_verified_keeps_existing_verified_and_wrapped_lines(self):
        mod = load_mod()
        markdown = (
            "### Not verified\n\n"
            "- [ ] Uploaded referral PDFs show viewer-local date/time next to the\n"
            "      filename.\n\n"
            "### Verified\n\n"
            "- [x] Already verified item.\n\n"
            "## Out of this ship\n"
        )
        updated = mod.move_verified_lines(
            markdown,
            {
                "Uploaded referral PDFs show viewer-local date/time next to the filename."
            },
        )
        verified = updated.split("### Verified", 1)[1]
        self.assertIn("- [x] Already verified item.", verified)
        self.assertIn("- [x] Uploaded referral PDFs", verified)
        self.assertIn("filename.", verified)
        self.assertNotIn(
            "- [ ] Uploaded referral PDFs",
            updated.split("### Verified")[0],
        )

    def test_failed_comment_is_idempotent_by_marker(self):
        mod = load_mod()
        row = {
            "item": "Care hop orgs",
            "host": "admit.dev",
            "ship": "474",
            "status": "failed",
            "permalink": "https://comita.slack.com/archives/C1/p1725",
        }
        body = mod.failed_comment_body(row)
        key = mod.failed_comment_key("474", "Care hop orgs")
        self.assertIn(mod.failed_marker(key), body)
        self.assertIn("Care hop orgs", body)
        self.assertIn("https://comita.slack.com/archives/C1/p1725", body)
        self.assertEqual(mod.ship_issue("#474 / 2026-08-13"), "474")


class ChannelTests(unittest.TestCase):
    def test_notify_channel_defaults_to_comita_support(self):
        mod = load_mod()
        old = os.environ.pop("COMITA_VERIFY_NOTIFY_CHANNEL_ID", None)
        try:
            self.assertEqual(mod.notify_channel(), "#comita-support")
            os.environ["COMITA_VERIFY_NOTIFY_CHANNEL_ID"] = "C123"
            self.assertEqual(mod.notify_channel(), "C123")
        finally:
            if old is None:
                os.environ.pop("COMITA_VERIFY_NOTIFY_CHANNEL_ID", None)
            else:
                os.environ["COMITA_VERIFY_NOTIFY_CHANNEL_ID"] = old

    def test_resolve_channel_passes_through_an_id(self):
        mod = load_mod()
        self.assertEqual(mod.resolve_channel("xoxb-test", "C123"), "C123")


if __name__ == "__main__":
    unittest.main()

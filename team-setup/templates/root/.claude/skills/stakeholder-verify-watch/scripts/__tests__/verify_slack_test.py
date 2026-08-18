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


class SlackFieldShapeTests(unittest.TestCase):
    def test_item_status_reads_list_of_field_objects(self):
        mod = load_mod()
        entry = {
            "fields": [
                {
                    "column_id": "ColAAA",
                    "key": "name",
                    "text": "Care mention emails fire",
                    "value": "Care mention emails fire",
                },
                {
                    "column_id": "ColBBB",
                    "key": "Status",
                    "value": "Verified",
                    "select": "Verified",
                },
                {
                    "column_id": "ColCCC",
                    "key": "Notes",
                    "text": "ok on admit.dev",
                    "value": "ok on admit.dev",
                },
            ]
        }
        item, status, notes = mod.item_status(entry)
        self.assertEqual(item, "Care mention emails fire")
        self.assertEqual(status, "verified")
        self.assertEqual(notes, "ok on admit.dev")

    def test_item_fields_uses_column_id_and_typed_values(self):
        mod = load_mod()
        cols = {
            "item": "ColITEM",
            "host": "ColHOST",
            "status": "ColSTATUS",
            "ship": "ColSHIP",
        }
        fields = mod.item_fields(
            cols,
            item="Care hop orgs",
            host="admit.dev",
            ship="474",
        )
        by_col = {field["column_id"]: field for field in fields}
        self.assertEqual(by_col["ColHOST"]["select"], ["admit.dev"])
        self.assertEqual(by_col["ColSTATUS"]["select"], ["not_verified"])
        item_text = by_col["ColITEM"]["rich_text"][0]["elements"][0]["elements"][0][
            "text"
        ]
        self.assertEqual(item_text, "Care hop orgs")
        self.assertNotIn("key", fields[0])
        self.assertNotIn("value", fields[0])

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
            "notes": "picker empty",
            "status": "failed",
        }
        body = mod.failed_comment_body(row)
        key = mod.failed_comment_key("474", "Care hop orgs")
        marker = mod.failed_marker(key)
        self.assertIn(marker, body)
        self.assertIn("picker empty", body)
        self.assertEqual(mod.ship_issue("#474 / 2026-08-13"), "474")


class ChannelNotifyTests(unittest.TestCase):
    def test_notice_includes_channel_mention_ship_and_list_url(self):
        mod = load_mod()
        text = mod.new_items_notice(
            ship="474",
            list_url="https://app.slack.com/lists/T0/F0",
            rows=[{"item": "Care hop orgs", "host": "admit.dev"}],
        )
        self.assertIn("<!channel>", text)
        self.assertIn("Ship: #474", text)
        self.assertIn("[admit.dev] Care hop orgs", text)
        self.assertIn("https://app.slack.com/lists/T0/F0", text)
        self.assertIn("1 new sandbox verify item to smoke", text)

    def test_notify_new_items_posts_comita_support(self):
        mod = load_mod()
        calls: list[tuple[str, dict]] = []

        def fake_post(method, token, payload):
            calls.append((method, payload))
            return {"ok": True}

        orig = mod.slack_post
        mod.slack_post = fake_post
        try:
            mod.notify_new_items(
                "xoxb-test",
                channel="#comita-support",
                list_url="https://app.slack.com/lists/T0/F0",
                ship="474",
                rows=[{"item": "Care hop orgs", "host": "admit.dev"}],
            )
            mod.notify_new_items(
                "xoxb-test",
                channel="#comita-support",
                list_url="https://app.slack.com/lists/T0/F0",
                ship="474",
                rows=[],
            )
        finally:
            mod.slack_post = orig
        self.assertEqual(len(calls), 1)
        method, payload = calls[0]
        self.assertEqual(method, "chat.postMessage")
        self.assertEqual(payload["channel"], "#comita-support")
        self.assertIn("<!channel>", payload["text"])
        self.assertFalse(payload["unfurl_links"])

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


if __name__ == "__main__":
    unittest.main()

from pathlib import Path
import importlib.util
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


if __name__ == "__main__":
    unittest.main()

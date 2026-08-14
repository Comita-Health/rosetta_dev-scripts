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


if __name__ == "__main__":
    unittest.main()

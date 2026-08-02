# No tool marketing in git / PRs

Do **not** add Cursor (or other AI-tool) marketing attribution to commits or
pull requests.

Forbidden in commit messages and PR titles/bodies:

- `Made with Cursor` / `Made with [Cursor](...)` footers
- `Made-with: Cursor` trailers
- `Co-authored-by: Cursor` / `Co-authored-by: cursoragent` (unless a human
  explicitly asks for that identity)

## Operator setup (Cursor)

1. **IDE:** Cursor Settings → Agents (or Git & PRs) → Attribution → turn **off**
   Commit Attribution and PR Attribution.
2. **CLI (global only):** `~/.cursor/cli-config.json` must include:

```json
"attribution": {
  "attributeCommitsToAgent": false,
  "attributePRsToAgent": false
}
```

   Cursor only allows `permissions` in project `.cursor/cli.json` — putting
   `attribution` there fails schema validation and blocks the Agent CLI from
   starting. Keep attribution opt-out in the global config.

## Agent behavior

- When drafting `gh pr create` / `gh pr edit` bodies, never append a Cursor
  footer yourself.
- After `gh pr create`, if the published body still contains a Made with Cursor
  line (known Cursor injection bug even when attribution is off), strip it
  immediately before considering the PR ready. Prefer
  `gh api -X PATCH repos/{owner}/{repo}/pulls/{n} -f body=...` — `gh pr edit`
  can still get a footer re-appended by the Cursor client.
- Prefer HEREDOC / `--body-file` for PR bodies so content stays under agent
  control.

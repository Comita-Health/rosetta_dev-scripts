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
2. **CLI:** `~/.cursor/cli-config.json` must include:

```json
"attribution": {
  "attributeCommitsToAgent": false,
  "attributePRsToAgent": false
}
```

3. **Workspace:** `.cursor/cli.json` also sets those flags to `false` (team-setup
   lays this down) so project sessions inherit the opt-out.

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

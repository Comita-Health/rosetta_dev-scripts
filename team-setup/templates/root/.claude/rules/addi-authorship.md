# Addi authorship for PRs and issues (mandatory)

Agent-authored GitHub **pull requests** and **issues** must be created as the
workspace GitHub App (**Addi**), never as the human operator’s `gh` login.
Humans need to Approve Addi PRs; if the PR is opened as the human, they cannot
Approve their own PR and the proceed signal breaks.

## Hard rules

1. **Before** `gh pr create`, `gh issue create`, or GraphQL
   `createPullRequest` / `createIssue`, activate Addi:

   ```bash
   # Comita-Health repos
   eval "$(bash ~/.config/comita/github-app-activate.sh)"

   # Rosetta-Foundation repos
   eval "$(bash ~/.config/rosetta/github-app-activate.sh)"
   ```

2. **Verify** the token is the app before creating:

   ```bash
   gh api graphql -f query='query { viewer { login } }' --jq '.data.viewer.login'
   # Expect: addi-m[bot] or rosetta-s-addi-m[bot] (or the org’s Addi slug)
   ```

   If the login is the human (`Roustalski`, etc.), **stop** — do not create.

3. **Never** fall back to ambient human `gh` auth for PR/issue creation just
   because Addi returned 403. Report the permission error and ask the human to
   grant the app `pull_requests: write` / `issues: write` on that repo.

4. After create, confirm author is the bot:

   ```bash
   gh pr view <n> -R owner/repo --json author --jq .author.login
   # Expect app/addi-m or app/rosetta-s-addi-m (etc.)
   ```

5. If a PR or issue was accidentally opened as the human: **close it** with a
   short note and **recreate as Addi** (same pattern as issue-resolve-watch
   “re-open as yourself”). Do not ask the human to Approve a self-authored PR.

6. Commits on agent branches should already use Addi’s
   `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` from the activate script when the
   agent is doing the push.

## Anti-patterns

- `unset GH_TOKEN` then `gh pr create` “because GraphQL failed once”.
- Opening the PR as human “just to land it” and hoping Approve still works.
- Mixing Comita Addi tokens on Rosetta-Foundation repos (or the reverse)
  without checking `viewer.login` and installation repos.

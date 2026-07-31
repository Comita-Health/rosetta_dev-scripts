Add one or more repos to the Rosetta workspace setup. Usage: /add-repo <github-url> [<github-url> ...]

Rosetta uses a flat workspace layout: code repos live directly at the workspace root and are
configured under `flatRepos` in `team-setup/src/config/shared.json` (not under a project `dir`).

Steps:

1. Parse each URL to extract the repo name (e.g. `rosetta_atlas` from the URL) and the owning org.
2. Edit `team-setup/src/config/shared.json`:
   - Add each repo to the `flatRepos` array: `{ "name": "<repo-name>", "ghRepo": "<repo-name>", "label": "<Human Readable Name>" }`.
   - Derive the label by stripping the `rosetta_` prefix and converting to title case (e.g. `rosetta_atlas` → `Atlas`). Add a short tagline after an em dash if useful.
   - If the repo lives in a different GitHub org than `shared.org`, flag this to the user — the cloner uses a single `org` for `flatRepos`.
3. Run `yarn workspace team-setup dev -- update-config` to regenerate `all.code-workspace` and lay down config.
4. Run `yarn workspace team-setup dev -- setup --skip-install` to clone the new repos (existing clones are skipped).
5. Update the directory structure diagram in `README.md` and in `team-setup/templates/root/CLAUDE.md` to include the new entries.
6. Remind the user to commit and open a PR so teammates get the changes on their next pull.

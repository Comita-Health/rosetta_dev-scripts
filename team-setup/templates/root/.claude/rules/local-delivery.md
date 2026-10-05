# Local delivery (default for local-mode repos)

When a repo's `.sdlc/environments.json` sets `"ci": { "mode": "local" }`,
every PR there goes through the laptop loop instead of per-PR GitHub
Actions. Actions runs the full suite daily and deploys prod on promote.

- Follow the **`local-delivery`** skill: plan → TDD commits → local CI
  (`ci.command`, incl. CDK snapshot comparison) → open the PR as Addi →
  post the `local-ci` status → fresh reviewer subagent → fix → sandbox
  deploy (`sandbox.deployCommand`) → `pr-approve-watch`.
- Merge-on-approve requires the `local-ci` commit status on the PR head.
  Re-run the CI command with `--post-status` after every push.
- The sandbox deploys from the laptop. Wait for `LOCAL_DEPLOY_GREEN` /
  `LOCAL_DEPLOY_FAILED`. Exit 3 is a tripped guard — stop and ask.
- Expired AWS session: run the workspace SSO login in the background and
  tell the human a browser sign-in is waiting.
- Do **not** arm `pr-checks-watch` or `deploy-verify-watch`, and do not
  dispatch the deploy workflow, in local-mode repos.
- Reviewer findings: fix blockers and majors; at most 2 rounds, then ask.

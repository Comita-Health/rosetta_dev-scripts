# Local delivery (default for local-mode repos)

When a repo's `.sdlc/environments.json` sets `"ci": { "mode": "local" }`,
every PR there goes through the laptop loop instead of per-PR GitHub
Actions. Actions runs the full suite daily and deploys prod on promote.

- Follow the **`local-delivery`** skill: arm the drop with
  `--require-approve` (it only counts at arm) → plan → TDD commits →
  `ci.command` until green (incl. CDK snapshot comparison) → open the PR as
  Addi → `ci.statusCommand` to post the `local-ci` status → fresh reviewer
  subagent → fix → `sandbox.localDeployCommand` → `pr-approve-watch`.
- Every PR in a local-mode repo needs `local-ci` on its head, docs-only too.
- Merge-on-approve requires the `local-ci` commit status on the PR head.
  Run `ci.statusCommand` after every push.
- The sandbox deploys from the laptop. Wait for `LOCAL_DEPLOY_GREEN` /
  `LOCAL_DEPLOY_FAILED`. Exit 3 is a tripped guard — stop and ask.
- Expired AWS session: start the workspace SSO login in a background shell
  (Comita: `aws sso login --profile "${COMITA_SSO_PROFILE:-bakerorgrwat}"`)
  and tell the human a browser sign-in is waiting.
- Do **not** arm `pr-checks-watch` or `deploy-verify-watch`, and do not
  dispatch the deploy workflow, in local-mode repos.
- Reviewer findings: fix blockers and majors; at most 2 rounds, then ask.

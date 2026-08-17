# Deploy verify watch (live smoke before land)

When you open or push to a PR that needs **live host verification** before
merge (auth/logout/`redirect_uri`, cookie SSO, multi-SPA cutover, Deploy Org
wiring), or the user asks to watch deploy-verify:

- Follow the **`deploy-verify-watch`** skill.
- Arm `.cursor/skills/deploy-verify-watch/scripts/watch-deploy-verify.sh` in the background with agent wake on
  `AGENT_LOOP_WAKE_deploy_verify` (use `--dispatch-on-arm` so the current head
  deploys without waiting for another push).
- On `deploy_green`: tell the human to re-smoke; do **not** merge on green
  alone. If the operator **linked a Slack thread** when requesting the
  item, reply in **that thread** that a new update for the issue has been
  deployed to **SB** (sandbox). No `@channel`. PHI-free. Not on push/CI.
- On `deploy_failed`: remediate, push; the watcher re-dispatches.
- After a fix that invalidates a smoke, **do not wait for chat** to redeploy.
- Pair with `pr-approve-watch` for Approve → comment triage → merge.
- Heuristics: label `verify-live`, or paths/keywords in the skill; when unsure,
  arm anyway.

---
name: sdlc-prd-progress
description: >-
  Show where a PRD stands in sdlc-workflow shadow implementation: Draft/Approved
  spec, run status, task merges, gate verdicts, and open PRs. Use when the user
  asks how far a PRD or SPEC is, "where are we in the SDLC run", shadow progress,
  or how much work remains before Done/Accepted.
---

# SDLC / PRD shadow progress

Answer **where a PRD's implementation is** using the shadow-mode run state and
the Approved/Done implementation spec — not by guessing from the PRD's product
status field alone.

## Two status fields (do not confuse them)

| Artifact | Typical path | Meaning |
| -------- | ------------ | ------- |
| **PRD** | `*/docs/product/PRD-NNNN-*.md` or `rosetta_docs/product/` | Product intent. `Draft`/`Accepted` is **product** lifecycle. |
| **Implementation spec** | `<app-repo>/specs/PRD-NNNN/phase-N-spec.md` | Execution plan (ADR-0008). `Draft` → human flip → `Approved` → `run` → `Done`. |

A PRD can still say `Draft` while the spec is `Approved` and tasks are merging.
Prefer the **spec + `sdlc-workflow status`** for "how much longer?"

## Steps (run these; then summarize)

1. **Locate the spec** for the PRD (e.g. `**/specs/PRD-0003/phase-*-spec.md`).
   Read frontmatter `status`, `id`, task list, and checkbox progress.
2. **Find the run id** — usually `<spec-basename>-<YYYY-MM-DD>` (e.g.
   `phase-1-spec-2026-08-01`). List `~/.rosetta/sdlc-runs/` if unsure.
3. **Scorecard** from the engine (from `rosetta_dev-scripts/sdlc-workflow`):

   ```bash
   bunx tsx src/index.ts status --run-id <run-id> | head -80
   ```

4. **Open / merged PRs** for the run's branches:

   ```bash
   gh pr list -R <owner>/<repo> --search "sdlc/<run-id>" --state all \
     --json number,title,state,mergedAt,url,headRefName
   ```

5. **Live tip** (optional): if the repo has a sandbox URL in
   `.sdlc/environments.json`, curl health / `version.json` to see whether
   merges have deployed.

## Output format (keep it short)

```markdown
### PRD-NNNN — shadow progress

| Layer | Status |
| ----- | ------ |
| PRD product status | Draft / Accepted / … |
| Spec | SPEC-… status + path |
| Run | `<run-id>` · tip merge SHA |
| Tasks | T-01 ✅ merged · T-02 ✅ · … · T-0N 🔲 PR #… / in gates / blocked |

**Gates (shadow):** note pass/breach per latest task — breaches against frozen
`baseSha` after merges are often false positives (see rosetta_dev-scripts#42/#43).

**ETA:** one sentence (e.g. "human merge of T-05 PR, then record-merge + mark
spec Done").

**Next operator action:** approve/merge PR, `record-merge --task T-0N`, or
flip spec `Draft → Approved`.
```

## Heartbeat (while `run` is in flight)

Spawn with OS `nohup` (not IDE background) — see rosetta_dev-scripts#38:

```bash
nohup bunx tsx src/index.ts run … > /tmp/sdlc-run.log 2>&1 &
echo $! > /tmp/sdlc-run.pid
```

Poll ~30s:

```bash
PID=$(cat /tmp/sdlc-run.pid)
ps -p "$PID" -o etime=,command=
pgrep -lf 'cursor-agent' | head -5
bunx tsx src/index.ts status --run-id <run-id> | head -40
tail -20 /tmp/sdlc-run.log
git -C ~/.rosetta/sdlc-runs/<run-id>/worktrees/<taskId> log -1 --oneline
git -C ~/.rosetta/sdlc-runs/<run-id>/worktrees/<taskId> status --porcelain | head
gh pr list --head "sdlc/<run-id>/<taskId>" --json number,url,state
```

## Closeout checklist (phase complete)

1. Every task has `merged@` in `status` (`record-merge --task … --sha …`).
2. Spec frontmatter `status: Done`.
3. PRD acceptance criteria ticked; PRD `status: Accepted` when product agrees.
4. Chronicle digests already posted by the run; optional human note in personal
   chronicle queue.

## Do not

- Treat PRD `Draft` as "implementation not started."
- Paste multi-thousand-line reviewer mega-diffs into other agent sessions.
- Re-run `decompose` for progress — that creates a new Draft spec.

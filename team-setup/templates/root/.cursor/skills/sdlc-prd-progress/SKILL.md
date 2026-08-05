---
name: sdlc-prd-progress
description: >-
  Show PRD implementation progress and portfolio visibility: single-run
  scorecards (spec, merges, gates, open PRs) plus an inventory of in-flight
  PRDs that may be idle/parked (Draft/Proposed, open docs PRs, stale runs).
  Use when the user asks how far a PRD/SPEC is, "what's in flight", which PRDs
  are parked, portfolio status, or /sdlc-status / /prd-portfolio.
---

# SDLC / PRD progress & portfolio

Two modes:

| Mode              | When                                  | Goal                                 |
| ----------------- | ------------------------------------- | ------------------------------------ |
| **A — Scorecard** | User names a PRD/SPEC/run             | Deep dive: tasks, merges, gates, ETA |
| **B — Portfolio** | "What's in flight?", parked/idle PRDs | Inventory across the workspace       |

## Two status fields (do not confuse them)

| Artifact                | Typical path                                              | Meaning                                                                                         |
| ----------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **PRD**                 | `*/docs/product/PRD-NNNN-*.md` or `rosetta_docs/product/` | Product intent. `Draft` → `Proposed` → `Accepted` → `Shipped` (then `Superseded`/`Deprecated`). |
| **Implementation spec** | `<app-repo>/specs/PRD-NNNN/phase-N-spec.md`               | Execution plan (ADR-0008). `Draft` → human flip → `Approved` → `run` → `Done`.                  |

A PRD can still say `Draft` while the spec is `Approved` and tasks are merging.
Prefer **spec + `sdlc-workflow status`** for "how much longer?"

**Namespace warning:** Consumer `PRD-NNNN` and Rosetta `PRD-NNNN` are different
products / namespaces. Always show the repo/path.

---

## Mode B — Portfolio (in-flight + parked)

Use when the user wants visibility beyond the active run — including PRDs that
are Draft/Proposed or have specs/runs but **are not actively being worked**.

### Steps

1. Run the inventory script from the workspace root (or skill template path):

   ```bash
   ROSETTA_WORKSPACE="$PWD" \
     bash .cursor/skills/sdlc-prd-progress/scripts/prd-portfolio.sh
   ```

   Useful env vars:

   | Var                         | Default | Effect                                     |
   | --------------------------- | ------- | ------------------------------------------ |
   | `PRD_PORTFOLIO_SCOPE`       | `all`   | `platform` \| `consumer` \| `all`          |
   | `PRD_PORTFOLIO_STALE_HOURS` | `48`    | Younger runs → `warm`                      |
   | `PRD_PORTFOLIO_ALL`         | `0`     | `1` includes Shipped/Deprecated/Superseded |

2. Supplement with open docs PRs that **add** PRDs not yet on the default
   branch. The script lists `gh pr list` for `rosetta_docs` and every
   non-Rosetta `*_docs` repository with `PRD` in the title. A consumer
   `PRD-0008` may only exist on an open PR.

3. Optionally list local runs: `ls ~/.rosetta/sdlc-runs/`.

### Bucket meanings

| Bucket    | Meaning                                               |
| --------- | ----------------------------------------------------- |
| `active`  | Live `sdlc-workflow` process for a matching run       |
| `warm`    | Run `updatedAt` within stale threshold                |
| `parked`  | Spec and/or run exists, but idle / no recent activity |
| `backlog` | Draft/Proposed/Accepted product PRD, no spec/run yet  |
| `other`   | Unusual product status without run activity           |

### Output format (keep it short)

```markdown
### PRD portfolio (in-flight)

**Active / warm**

- …

**Parked** (spec or run, not actively worked)

- Consumer PRD-0006 — Draft · no spec · backlog→parked if you treat open intent
- …

**Backlog** (Draft/Proposed/Accepted, no execution yet)

- …

**Open docs PRs** (PRD not on default branch yet)

- consumer_docs#12 — PRD-0008 Draft …
```

Group by **product family** (consumer vs platform). Call out parked items
explicitly — that is the point of this mode.

Industry practice aligns with a live portfolio view (status + delivery link +
idle detection) rather than a static deck; this script is the lightweight
workspace equivalent of that dashboard.

---

## Mode A — Single PRD scorecard

### Steps (run these; then summarize)

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

### Output format

```markdown
### PRD-NNNN — shadow progress

| Layer              | Status                                                            |
| ------------------ | ----------------------------------------------------------------- |
| PRD product status | Draft / Proposed / Accepted / Shipped / …                         |
| Spec               | SPEC-… status + path                                              |
| Run                | `<run-id>` · tip merge SHA                                        |
| Tasks              | T-01 ✅ merged · T-02 ✅ · … · T-0N 🔲 PR #… / in gates / blocked |

**Gates (shadow):** note pass/breach per latest task — breaches against frozen
`baseSha` after merges are often false positives (see rosetta_dev-scripts#42/#43).

**ETA:** one sentence (e.g. "human merge of T-05 PR, then record-merge + mark
spec Done").

**Next operator action:** approve/merge PR, `record-merge --task T-0N`, or
flip spec `Draft → Approved`.
```

## Heartbeat (while `run` is in flight)

**Default:** follow the **`sdlc-run-supervise`** skill — engine
`--supervise --detach`, `--heartbeat`, end the agent turn, check in on wakes.
Do **not** block the chat with multi-minute `sleep`/poll loops (sandbox alone
is often 7+ min). See `sdlc-workflow/docs/operator-background-supervise.md`
and `/sdlc-run`.

```bash
bunx tsx src/index.ts run … --heartbeat 30 --supervise --detach
```

On each wake (e.g. `/loop` 2–5m), cheap pulse only:

```bash
RUN="$HOME/.rosetta/sdlc-runs/<run-id>"
ps -p "$(cat "$RUN/supervise.pid")" -o etime=,command= || echo DEAD
bunx tsx src/index.ts status --run-id <run-id> | head -40
tail -20 "$RUN/monitor.log"
tail -3 "$RUN/heartbeat.jsonl"
gh pr list --head "sdlc/<run-id>/<taskId>" --json number,url,state
```

## Closeout checklist (phase complete)

1. Every task has `merged@` in `status` (`record-merge --task … --sha …`).
2. Spec frontmatter `status: Done`.
3. PRD acceptance criteria ticked; PRD `status: Accepted` while phases remain, then `Shipped` when planned phases are complete.
4. Chronicle digests already posted by the run; optional human note in personal
   chronicle queue.

## Do not

- Treat PRD `Draft` as "implementation not started."
- Hide parked/idle Drafts when the user asks what is in flight — list them under
  **Parked** or **Backlog**.
- Paste multi-thousand-line reviewer mega-diffs into other agent sessions.
- Re-run `decompose` for progress — that creates a new Draft spec.
- Equate consumer PRD-NNNN with Rosetta PRD-NNNN.

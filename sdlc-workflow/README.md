# sdlc-workflow

PRD-0011 (Full-Loop SDLC Automation):

- **Phase 1** (`decompose`, [SPEC-PRD-0011-P1](../specs/PRD-0011/phase-1-spec.md)):
  decompose a PRD into product stories, synthesize an
  [ADR-0008](https://github.com/Rosetta-Foundation/rosetta_docs/blob/main/architecture/ADR-0008-implementation-spec-format.md)
  implementation spec with a blast-radius envelope, write it to the target
  repo as `Draft`, and stop at the human gate.
- **Phase 2** (`run`, [SPEC-PRD-0011-P2](../specs/PRD-0011/phase-2-spec.md),
  done): execute one ready task from an Approved spec in an isolated
  worktree, run machine gates in **shadow mode** (verdicts recorded, never
  enforced), and halt — human approval is the only advance mechanism.
- **Phase 3** ([SPEC-PRD-0011-P3](../specs/PRD-0011/phase-3-spec.md),
  done — live-validated 2026-08-01, run `p3-live-val` auto-merged
  [PR #32](https://github.com/Rosetta-Foundation/rosetta_dev-scripts/pull/32)):
  parallel fan-out across ready tasks, real PR lifecycle with a
  bounded CI fix cycle, gate enforcement with auto-merge on green,
  post-merge sandbox deploy + PRD-0007 digest with veto-triggered revert.
  Landed: the T-01 dependency-ordered task pool; the T-02 PR
  lifecycle — each completed task branch is pushed and gets a real PR
  (idempotent on resume), which is the reviewer- and CI-gate subject;
  the T-03 live CI monitor — checks are polled to terminal and failures
  dispatch a fix agent (at most 3 attempts, persisted across resume)
  before the post-cycle verdict reaches the aggregator; and T-04 gate
  enforcement — all four gates green auto-merges the task PR (merge SHA
  recorded in run state and the `sdlc.merge.v1` artifact, attributed to
  `machine-gates`), any red gate blocks with a `merge-blocked`
  escalation, and `--shadow` restores the record-only calibration mode;
  and T-05 phase boundary — once every task has merged, the merged
  default branch deploys to the sandbox (SHA-idempotent, step-cached)
  and the phase digest posts to the PRD-0007 queue with merge links; a
  `[veto]` tag on that item (`check-veto`) reverts the phase merges
  through a PR, redeploys the sandbox at the reverted SHA, and records
  an `sdlc.revert.v1` Chronicle artifact; and T-06 escalation surface —
  each exception trigger posts an `action-required` queue item (task,
  trigger, evidence refs), token spend against `budgetK` halts new agent
  dispatches pool-wide, and `status` categorizes tasks as merged /
  halted-escalated / blocked-by-dependency so a partial failure is
  triageable without opening state files.

## Usage

```bash
cd sdlc-workflow
bun install

# Phase 1: decompose a PRD and write the Draft spec into a target repo
bun run dev -- decompose --prd PRD-0011 --repo ../../rosetta_chronicle

# Options
#   --docs-dir   PRD location (default: ../rosetta_docs/product)
#   --phase      rollout phase to specify (default: 1)
#   --budget-k   token budget in thousands, recorded in the envelope (default: 200)

# Lint a spec file's format before intake (no LLM call, no --repo; hook/CI safe)
bun run dev -- spec-lint --spec ../specs/PRD-0011/phase-2-spec.md

# Execute all ready tasks from an Approved spec (parallel worktrees)
bun run dev -- run --spec ../specs/PRD-0011/phase-3-spec.md --repo .. \
  --chronicle-repo ../../rosetta_chronicle_roustalski

# Options
#   --run-id          stable run identifier; branches are sdlc/<run-id>/<task-id>
#                     (default: <spec-file>-<date>)
#   --runs-dir        run state + worktrees location (default: ~/.rosetta/sdlc-runs)
#   --chronicle-repo  personal Chronicle ledger repo; enables the T-07 queue
#                     digest and T-08 artifact commits (skipped when absent)
#   --max-parallel    concurrent implementation agents per wave (default: 3)
#   --shadow          record gate verdicts but never merge (calibration mode)
#   --heartbeat       emit structured progress every N seconds (default: 30;
#                     0 disables). Also appends <runsDir>/<runId>/heartbeat.jsonl
#   --operator        GitHub login assigned on needs-human escalation issues
#                     (also accepted via SDLC_OPERATOR env; never hardcoded)

# Operator default: detach with --supervise --detach + --heartbeat, then check
# in on wakes — do not block the agent chat on sandbox waits.
# See docs/operator-background-supervise.md (team-setup skill: sdlc-run-supervise).

# Record a human-approved merge in the run's Chronicle artifact (T-08);
# --task marks that task merged, which unblocks its dependents (P3 T-01)
bun run dev -- record-merge --run-id <run-id> --sha <merged-sha> \
  --task T-01 --chronicle-repo ../../rosetta_chronicle_roustalski

# After a human vetoes the phase digest ([veto] tag on the queue item),
# revert the phase merges and redeploy the sandbox (P3 T-05)
bun run dev -- check-veto --run-id <run-id> --repo .. \
  --chronicle-repo ../../rosetta_chronicle_roustalski

# Inspect a run: task results, cached step graph, verdicts, exceptions (T-09)
bun run dev -- status --run-id <run-id>

# Lint an ADR-0008 spec before intake (front-matter parse, envelope schema,
# checkbox integrity) — no LLM call, no --repo; hook/CI safe (#40)
bun run dev -- spec-lint --spec ../specs/BUG-envelope-spec-integrity/phase-1-spec.md
```

`decompose` grounds the synthesized envelope in the target repo tree (#35):
every `allowedPaths` glob must match at least one existing path in the
`--repo` checkout, or be justified as a new-path intent by a task naming
the file it creates in its engineering notes. Anything else fails synthesis
with `ENVELOPE_UNGROUNDED`, listing the offending globs. A diff-forecast
heuristic also warns (without blocking) when a task's engineering notes
reference a path no `allowedPaths` glob covers, so the human reviews a
coherent envelope instead of discovering the gap as a mid-run breach.

`decompose` hard-stops after writing the Draft spec. Approval is a
`status: Draft → Approved` flip in a dedicated commit (ADR-0008) —
`run` refuses anything but an Approved spec, records the refusal as a
blocked verdict in `state.json`, and exits non-zero. A launch record
(`state.json` with run id, spec digest, base SHA, argv, `startedAt`, empty
steps) is written at invocation start — before intake — so a crash never
leaves `status` answering `RUN_NOT_FOUND` (#37). Surface labels fail closed
at synthesis (#36): every synthesized `forbiddenSurfaces` label must resolve
against the target repo's `.sdlc/surfaces.json`, and an unresolvable label
aborts `decompose` with `SURFACE_UNRESOLVABLE` — the label named and the
repo's known labels listed — rather than being silently dropped before a
human reviews the spec. The known labels are also fed into the synthesis
prompt so the model picks from real surfaces. The envelope
gate evaluates the task branch diff against the spec's blast-radius envelope
(forbidden-surface labels resolve via `.sdlc/surfaces.json` read from the
tree under judgment — see the tree-resolution rule below). Since
P3 T-04 the gates enforce by default: green across the board merges the
task PR automatically; any red gate blocks and escalates (`--shadow`
disables enforcement for calibration).

### Spec-format lint and the single-writer rule (#40)

The spec file is the one artifact humans and the machine must agree on
byte-for-byte, so two guards protect it:

- **`spec-lint --spec <path>`** validates an ADR-0008 spec's format with no
  LLM call and no `--repo` — safe from a pre-commit hook or CI. It reports
  named error classes across three layers: front-matter / structure parse
  (`SPEC_MALFORMED`), envelope schema and inline-array integrity
  (`SPEC_INVALID` / `SPEC_MALFORMED`), and checkbox integrity — every
  acceptance criterion present and carrying a recognized verification tier
  (`test:` | `agent:` | `manual:` | `docs:`). Its reason for existing is the
  Prettier incident: a formatter (or hand-edit) can reshape the inline
  envelope array into a YAML block sequence that the tolerant parser
  silently mis-joins into one garbage glob — the envelope then guards
  nothing. spec-lint names that reshape _before_ intake trips over it. Exit
  is non-zero with the offending field/criterion named on any finding.
- **Single-writer rule.** Acceptance-checkbox and `status:` state under
  `specs/**` has exactly one writer: the engine's phase closeout (a separate
  docs PR after the product tasks merge — PRD-0023). A product-task diff
  that edits its own spec file — flipping its own checkboxes — hard-breaches
  the envelope gate **even when `allowedPaths` would cover the spec path**
  (`services/envelope-gate.service.ts`, `isSpecTreePath`). Agents never tick
  their own criteria; the machine records checkbox state from gate verdicts
  at closeout.

### Engine branches and target-repo hooks (#41)

Task branches are `sdlc/<run-id>/<task-id>`. If the target repo's husky
pre-commit only allows `f/*` / `b/*`, agent `git commit -s` fails. The
engine therefore:

1. prompts agents to use `git commit --no-verify -s`, and
2. **owns a salvage commit** when the agent exits with a dirty worktree on
   the tip (`git add -A && git commit --no-verify -s`).

Target repos may alternatively allow `sdlc/*` in their branch check; either
path unblocks multi-task runs. CI still validates the PR.

### Spec integrity: `spec-lint` and the single-writer rule (#40)

Two guards protect the spec file itself.

**Single-writer rule.** A product-task diff must never edit anything under
`specs/**` (nor a nested `**/specs/**`) — including flipping its own
acceptance-criteria checkboxes or changing `status:`. The envelope gate
hard-breaches on any spec-tree path even when `allowedPaths` explicitly
covers it: the canonical self-ticking move (an agent closing its own
checkboxes in the same diff that implements the task) is a breach, not a
convenience. Checkbox state and phase `Done` closeout have exactly one
writer — the engine closeout / docs PR after the product tasks merge
(PRD-0023) — so run-time truth can never be forged mid-run.

**`spec-lint`.** `spec-lint --spec <path>` validates an Approved spec's
Markdown without an LLM call or a `--repo`, so it runs from a pre-commit
hook or CI. It layers three named checks and exits non-zero on the first
failing class:

- front-matter / structure parse (`SPEC_MALFORMED` — e.g. a missing
  envelope field),
- envelope schema + inline-array integrity (`SPEC_MALFORMED` for a
  formatter-reshaped array, `SPEC_INVALID` for an empty `allowedPaths` or a
  non-positive `maxDiffLines` / `budgetK`),
- checkbox integrity (`SPEC_INVALID` when a task carries no criteria,
  `SPEC_MALFORMED` when a criterion is missing a recognized verification
  tier — `test:` / `agent:` / `manual:` / `docs:`).

Its reason for existing is the Prettier incident: `prettier --write` on a
`*.md` spec can fold the envelope's inline flow array into a YAML block
sequence that the tolerant parser silently mis-joins into one garbage glob,
after which the envelope guards nothing. `spec-lint` names that reshape
before intake silently accepts it.

### Progress heartbeat (#39)

`run --heartbeat <seconds>` (default `30`) prints
`[heartbeat] {json}` lines with `runId`, `taskId`, `step`, `stepElapsedMs`,
`agentAlive`, `worktreeDirty`, `worktreeHead`, and `lastLine`, and appends
the same records to `<runsDir>/<runId>/heartbeat.jsonl`. Pass `--heartbeat 0`
to disable. Prefer OS `nohup` for long detached runs (see #38 / #43 F2) —
do not rely on IDE harness backgrounding.

### Detached / supervise exit detection (#38)

A `--supervise` (or detached supervise child) process installs exit traps so
**trappable** terminations — clean return, thrown error, `SIGTERM` /
`SIGINT` — always write:

| Artifact                           | Role                                                    |
| ---------------------------------- | ------------------------------------------------------- |
| `<runsDir>/<runId>/supervise.exit` | JSON `{ code, reason, abnormal, at }`                   |
| `monitor.log` terminal line        | `[supervise] exit code=… reason=… abnormal=…`           |
| Durable wake                       | `sdlc_supervisor` event under `~/.rosetta/wake/pending` |

`abnormal: false` is reserved for legitimate all-tasks-merged completion
(`code: 0`). A zero exit that left work incomplete (`stopped`, e.g.
`no-ready-task` / shadow human gate) is still `abnormal: true` so the
artifacts alone distinguish quiet incompleteness from success.

**Detection boundary:** exit traps own every termination Node can handle.
`SIGKILL`, OOM-kill, and power-loss cannot run a handler by definition —
those remain the continuity layer's job (`supervise.pid` liveness +
heartbeat staleness in `sdlc-continuity-daemon.sh`). Startup-window death
(child dies before the first wave) is still caught by the detach parent's
post-spawn grace probe (PR #83/#84).

## Repo-owned `.sdlc/` contracts

The engine never owns deployment or test mechanics — the target repo
declares them:

```jsonc
// .sdlc/environments.json — only the "sandbox" entry is ever read (S-04:
// no code path can reach any other environment). Commands receive the
// deployed SHA as SDLC_SANDBOX_SHA; health output must echo it.
{
  "sandbox": {
    "deployCommand": "git push origin HEAD:build-env/dev && gh run watch --exit-status",
    "healthCommand": "curl -fsS https://app.dev.example.com/health",
    "timeoutMinutes": 45 // default
  }
}

// .sdlc/verification.json — scripted check for test-tier criteria.
{ "testCommand": "bun test" }

// .sdlc/surfaces.json — forbidden-surface label → path globs. Also grounds
// synthesis (#36): decompose aborts on any forbiddenSurfaces label missing
// from this map (SURFACE_UNRESOLVABLE) instead of dropping it.
{ "migrations": ["**/migrations/**"] }
```

```markdown
<!-- .sdlc/review-checklist.md — optional; a flat checkbox list the reviewer
     evaluates item by item (T-01). Trailing "(mandatory)" is a hard bar: a
     failed mandatory item overrides a concurring verdict. Absent file →
     unchanged pre-checklist prompt/verdict shape. The engine ships no
     content — the workspace's HSR/inline-docs bar lands here via
     team-setup; other consumers declare their own. -->
- [ ] Every new HSR class has TSDoc (mandatory)
- [ ] Prefer readability over cleverness
```

A missing contract never fails the run: the corresponding gate records
itself `blocked` (sandbox) or degrades the criteria to `human-required`
(verification), keeping the shadow-mode phase verdict honest. The one
evaluation-time exception is the surface map: an envelope that declares
`forbiddenSurfaces` cannot be judged without it, so a missing
`surfaces.json` at the judged tree is a named breach reason (see below). A
second, fail-closed exception is synthesis time: `decompose` refuses to
write a spec whose `forbiddenSurfaces` cannot all resolve against
`surfaces.json` (a missing map resolves no labels), because a label no gate
can enforce is a silent compliance hole, not a degradable check.

### Tree-resolution rule for evaluation-time `.sdlc/` reads

Any gate that reads a `.sdlc/` contract while judging a change must read
it from the **git tree under judgment** — the task's PR tip (or the merged
integration tip for phase-level checks) — never from the operator's local
checkout (SPEC-BUG-envelope-spec-integrity-P1 T-03). A locally edited
(uncommitted) contract therefore cannot sway a verdict, and a contract
missing from the judged tree is a **named gate error**, not a silent
local-file fallback.

Audit of evaluation-time `.sdlc/` call sites and how each complies:

- **Envelope gate → `surfaces.json`** — resolved as a git blob at the
  gate's `headRef` via `SurfaceMapRepository.loadAtRef` (`git show
  <ref>:.sdlc/surfaces.json`). Missing at that ref with
  `forbiddenSurfaces` declared → breach reason naming the contract path
  and the judged ref. `SurfaceMapRepository.load` (working-tree read)
  remains for synthesis-time use only; gates must not call it.
- **Reviewer gate → `review-checklist.md`** — resolved as a git blob at
  the gate's `headRef` via `ReviewChecklistRepository.loadAtRef` (T-01,
  same pattern as the surface map). Missing at that ref is not an error —
  the contract is optional, so a missing file degrades to the
  pre-checklist prompt/verdict shape rather than blocking the run.
- **Sandbox gate → `environments.json`** — loaded from the task
  **worktree**, which is the engine-owned checkout of the judged branch
  tip (commands must execute from a filesystem checkout). Compliant: the
  worktree *is* the judged tree.
- **Verification (test tier) → `verification.json`** — same worktree
  rule as the sandbox contract. Compliant for the same reason.

## Resumable step graph (T-09)

Every pipeline step — implementation, each gate, the digest post, the
Chronicle commit — is cached in run state under a key derived from a
SHA-256 **inputs digest** rooted at `{task content, integration tip}` and
chained through the worktree head SHA. Wave-1 tasks use the frozen run
`baseSha`; after `record-merge --task`, dependents branch from (and
envelope/reviewer diff against) the post-merge tip — see
[`docs/merged-tip-baseRef.md`](./docs/merged-tip-baseRef.md). Kill the run
at any boundary and rerun the same command: cache hits are replayed
(agents are not re-invoked, the sandbox is not redeployed, digests are not
re-posted), and only steps whose inputs changed or never completed execute.
Editing a task's spec content changes its digest and invalidates exactly
that task's chain. `status` shows what is cached versus what would
re-execute.

This repo dogfoods the pipeline against itself:
[`SPEC-LIVE-VALIDATION-P1`](../specs/PRD-0011/live-validation-spec.md) is a
one-task harness spec, and the root `.sdlc/` contracts declare a local
process sandbox (`scripts/sandbox-deploy.sh` stages the built CLI keyed by
`SDLC_SANDBOX_SHA`; `scripts/sandbox-health.sh` echoes it back).

## Chronicle integration (T-07 / T-08)

With `--chronicle-repo` set, the phase boundary:

- commits versioned JSON artifacts (`sdlc.spec.v1`, `sdlc.task-result.v1`,
  `sdlc.verdict.v1`, `sdlc.exceptions.v1`, `sdlc.digest.v1`,
  `sdlc.merge.v1`) under `chronicles/sdlc/<run-id>/`, and
- posts one informational digest item to the PRD-0007 personal queue
  (`chronicles/queue.md`, Inbox) — no veto or revert semantics this phase.

Ledger commits follow ADR-0007: `chronicle(sdlc): ...` /
`chronicle(queue): ...` with `Chronicle-Window:` and `Generated-By:`
trailers. Verdict artifacts carry gate identity, inputs digest, outcome,
and resolvable evidence refs, and read back through
`GatePolicyQueryService` so future gate policy can learn from track record.

## Environment

Inference runs over one of three transports, selected automatically:
`ANTHROPIC_API_KEY` present → Anthropic API (PRD-0011 §5 default); else
`OPENAI_API_KEY` present → OpenAI Responses API; otherwise the operator's
logged-in Cursor Agent CLI session (`cursor-agent -p`, the same
operator-auth pattern as `gh`).

| Variable                 | Required | Purpose                                                        |
| ------------------------ | -------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | no\*     | Anthropic API model calls (ADR-0003 / PRD-0011 §5)             |
| `ANTHROPIC_MODEL`        | no       | Override the Anthropic default model (`claude-sonnet-4-5`)     |
| `OPENAI_API_KEY`         | no\*     | OpenAI Responses API model calls                               |
| `OPENAI_MODEL`           | no       | Override the OpenAI default model (`gpt-5.6`)                  |
| `OPENAI_BASE_URL`        | no       | OpenAI-compatible gateway base URL (default: `api.openai.com`) |
| `SDLC_INFERENCE_BACKEND` | no       | Force a backend: `anthropic`, `openai`, or `cursor-cli`        |
| `CURSOR_AGENT_BIN`       | no       | Cursor Agent CLI binary (default: `cursor-agent`)              |
| `CURSOR_MODEL`           | no       | Model passed to the Cursor Agent CLI                           |

\* With neither key set, a logged-in `cursor-agent` session is required.

## Architecture

Handler / Service / Repository with InversifyJS (workspace rule):

- `handlers/workflow.handler.ts` — Phase 1 pipeline, prints the gate.
- `handlers/run.handler.ts` — pooled task loop: parallel executor wave +
  per-task gates + P3 T-04 enforcement (auto-merge on green, escalate on
  red, `--shadow` to record only) + digest/Chronicle steps, all through
  the T-09 step cache.
- `services/decompose.service.ts` — PRD → `ProductStory[]` (right-sizing prompt).
- `services/spec-synthesis.service.ts` — stories → tasks + envelope → validated
  ADR-0008 Markdown. Grounds `allowedPaths` in the target repo tree
  (`utils/envelope-grounding.ts`, #35): ungrounded globs fail with
  `ENVELOPE_UNGROUNDED`; task-note paths outside the envelope surface as
  diff-forecast warnings. Fails closed on `forbiddenSurfaces` labels that do
  not resolve against the target repo's `.sdlc/surfaces.json` (#36).
- `services/executor.service.ts` — approved-spec intake and the P3 T-01
  task pool: merged-dependency eligibility, bounded parallel agent
  fan-out, one worktree per task. Persists the #37 launch record
  (`state.json`) before intake so forensics survive a mid-start crash.
- `services/envelope-gate.service.ts` — diff vs blast-radius envelope,
  shadow-mode verdict (T-02); resolves `surfaces.json` at the judged ref,
  never local disk (envelope-spec-integrity T-03).
- `services/pr-lifecycle.service.ts` — P3 T-02: push the task branch,
  find-or-create its PR with deterministic title/body (`utils/pr-content`).
- `services/sandbox-deploy.service.ts` — task-branch build → sandbox via the
  repo-owned contract; idempotent per SHA, health must report the deployed
  SHA, structurally unable to reach any other environment (T-03).
- `services/verification.service.ts` — tiered acceptance-criteria runner:
  test-tier via the repo's scripted check, agent-tier via an independent
  verifier agent driving the sandbox, manual-tier forces human-required;
  every criterion verdict references its evidence artifact (T-04).
- `services/reviewer-publish.service.ts` — surfaces reviewer on the task PR
  (commit status context `sdlc/reviewer` + overview comment); best-effort
- `services/reviewer-gate.service.ts` — independent reviewer agent over the
  diff + task + envelope only; concur/disagree with cited reasons and the
  full transcript attached (T-05). When the target repo declares
  `.sdlc/review-checklist.md`, the prompt includes it and the verdict
  carries per-item `checklistFindings`; a failed `mandatory` item overrides
  a model concur to disagree (SPEC-BUG-reviewer-house-bar-P1 T-01).
- `services/aggregator.service.ts` — combines ci / verification / reviewer /
  envelope into one phase verdict and derives exception-ledger entries
  (reviewer disagreement, third CI fix attempt, envelope breach, budget
  exhaustion) (P2 T-06).
- `services/escalation.service.ts` — P3 T-06 / fail-loud T-04: turns
  exception entries into interrupting `action-required` queue items,
  assigned needs-human GitHub issues (`--operator` / `SDLC_OPERATOR`), and
  durable wake-inbox events (idempotent by title). Swallowed GitHub failures
  append a loud `monitor.log` warning without blocking the run.
- `repositories/issue.repository.ts` — `gh issue` create / find-by-title.
- `repositories/wake-inbox.repository.ts` — durable `~/.rosetta/wake` emits.
- `services/ci-gate.service.ts` — the live CI gate (P3 T-03): polls the
  pushed branch's check runs to terminal, dispatches a fix agent on
  failure (failing logs in the prompt, ≤3 attempts persisted in
  `ciFixAttempts`), pushes fixes, and returns the post-cycle verdict with
  the cycle transcript as evidence; honest `blocked` when the branch is
  not pushed.
- `services/digest.service.ts` — phase-boundary digest to the PRD-0007
  personal queue; append-only. Veto is a separate `check-veto` command
  that reads the item back (T-07 / P3 T-05).
- `services/chronicle-commit.service.ts` — versioned run artifacts +
  merged-SHA / veto-revert recording (`sdlc.merge.v1`, `sdlc.revert.v1`),
  committed per ADR-0007 (T-08 / P3 T-05).
- `services/gate-policy-query.service.ts` — reads verdict artifacts back
  for gate-policy consumption (T-08).
- `repositories/` — PRD parsing (`prd`), model transports (`anthropic`,
  `openai`, `cursor-cli` behind the shared `IModelRepository` contract in
  `model`),
  schema-constrained inference with one retry (`inference`), spec file writes
  (`spec-file`), spec reads (`spec-doc`), git worktrees/diffs (`git`),
  workspace-mutating agent runs (`agent-runner`), resumable run state with
  the step graph (`run-state`), protected-surface map (`surface-map`),
  the optional review checklist (`review-checklist`), `.sdlc/` contracts
  (`contract`), contract command execution
  (`shell-command`), evidence artifacts (`evidence`), PRD-0007 queue
  appends (`queue`), Chronicle ledger artifacts + ADR-0007 commits
  (`chronicle-artifact`), GitHub check-run status (`ci-status`).
- `utils/` — pure functions: PRD parser, JSON-schema validator, spec renderer,
  ADR-0008 format validator, spec parser (round-trip of the renderer), spec
  format lint (`spec-lint`, the hook/CI-safe pre-intake guard), glob
  matcher, criterion-tier parser, inputs digest (`digest`), the optional
  review-checklist markdown parser (`review-checklist`), and the
  implementation / reviewer / verifier agent prompt builders.

## Testing

```bash
bun run test:coverage   # jest via @swc/jest; 90% global thresholds
```

Repo CI runs this suite on every PR (`.github/workflows/ci.yml`), alongside
`team-setup`.

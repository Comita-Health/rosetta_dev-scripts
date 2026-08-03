Turn a bug report / repro discussion into a minimal Approved spec that runs through the same `sdlc-workflow run` machine as a feature — without going through a PRD or `decompose`.

Use this only for non-trivial or blast-radius-sensitive bugs (touches a forbidden surface, non-obvious fix, or you want it queued while you work on something else). A genuinely trivial, obviously-safe one-liner doesn't need the machine — just fix it directly on a branch and open a PR.

1. Copy `rosetta_docs/product/BUG-SPEC-TEMPLATE.md` verbatim as the starting point — do not write spec structure from memory. It uses a synthetic `prd: BUG-<slug>` id (not a real PRD file — the `prd` field is only used as a free-text label in the PR body and the `specs/<prdId>/` directory name; nothing resolves it against `rosetta_docs/product/`).
2. Fill in Context (symptom, exact repro, root cause if known) and a single Task T-01 with the fix. Keep `allowedPaths`/`maxDiffLines` tight — bugs are small by construction; if the envelope wants to be feature-sized, it's not a bug, use `/write-prd` instead.
3. Do not invent `forbiddenSurfaces` labels that aren't already defined in the target repo's `.sdlc/surfaces.json` — check that file first if the fix touches a sensitive surface.
4. Save it at `specs/BUG-<slug>/phase-1-spec.md` in the target repo (mirrors the PRD path's `specs/<prdId>/phase-<n>-spec.md` convention).
5. Human gate: leave `status: Draft` and stop for approval — flipping to `status: Approved` is the same single human gate the PRD path uses (PRD-0011 §3), just reached by a shorter road. In enforcing mode the run's intake gate checks the spec is committed to the default branch with `status: Approved` before it will execute (provenance check) — don't flip it locally and expect the run to start from an uncommitted change.
6. Once approved and merged to the default branch, kick it off the same way as any spec:
   ```
   sdlc-workflow run --repo <target-repo> --spec specs/BUG-<slug>/phase-1-spec.md --supervise --detach
   ```

The regression test acceptance criterion (`test:` tier) is the one criterion a bug spec cannot skip — it's what turns "the agent said it's fixed" into a verifiable, permanent guard against the bug recurring.

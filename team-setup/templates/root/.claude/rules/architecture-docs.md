# Architecture docs stay current

A change that alters architecture updates the architecture docs in the
same unit of work. The docs live in the docs repo, not the code repo.

## What counts

- A Lambda, queue, table, bucket prefix, API route, or WebSocket event
  added, removed, or repurposed
- A new message kind between services
- A new external vendor or integration, or a change in what is sent to one
- A change to the PHI boundary: what is stored, where, who can read it
- A new composition root, DI domain, or cross-service shared logic
- A change to auth, roles, or tenancy (who can see or do what)
- Anything that needs an ADR

Not counted: copy, styling, a bug fix inside an existing box, tests,
or a refactor that moves no boundary.

## Where

- Rosetta engine repos (`rosetta_*`): `rosetta_docs/architecture/`
- Consumer product repos: the consumer's docs repo. Comita:
  `comita_docs/docs/architecture/`. Update the living map
  `comita-platform.html`. Add or update a feature page (HTML, same
  style) when one box is not enough. Index it in that folder's
  `README.md`.
- PRDs stay where they already live. A decision that must still bind in
  a year is an ADR (see `work-intake`).

## How

1. Branch the docs repo from its default branch. Use a worktree when
   the primary checkout has unrelated edits.
2. Open the docs PR as Addi (`addi-authorship`) with `git commit -s`.
3. Link both ways: the code PR body has `## Architecture docs` with the
   docs PR URL, and the docs PR links the code PR.
4. The code PR is not ready for Approve until the docs PR is open.
   Merge the docs PR when the code merges, so the docs never describe
   unmerged code.
5. If nothing counted, the code PR body says
   `## Architecture docs` / `No architecture change.`

## Guardrails

- No PHI, no real patient data, no account ids or ARNs. Synthetic only.
- Spell the product Comita.
- Reviewers treat a missing docs update the same as a missing test.

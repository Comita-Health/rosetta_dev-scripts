# Contributing

Thanks for helping build Rosetta — infrastructure for collective intelligence.

Before proposing architectural or product changes, read the project
constitution in
[`rosetta_docs/foundations/`](https://github.com/Rosetta-Foundation/rosetta_docs/tree/main/foundations)
— founding context, principles, glossary, and settled decisions.

## License

This repo is licensed under [Apache-2.0](LICENSE). Contributions are accepted
**inbound = outbound**: by contributing, you license your work under the same
terms (see Apache-2.0 §5). You keep your copyright.

## Developer Certificate of Origin (DCO)

Every commit must be **signed off**, certifying the
[Developer Certificate of Origin](https://developercertificate.org) — a
one-line attestation that you wrote the change or otherwise have the right to
submit it under the project license. This is Rosetta's provenance principle
applied to contributions: rights travel with the commit, in every clone,
forever.

Sign off by adding the `-s` flag:

```bash
git commit -s -m "feat: your change"
```

which appends a trailer using your git identity:

```
Signed-off-by: Your Name <you@example.com>
```

Use the name you are known by in the community (a real identity someone could
contact — not an anonymous handle that misrepresents who you are).

Forgot to sign off? Amend the last commit with `git commit --amend -s
--no-edit`, or a range with `git rebase --signoff main`, then push again.

Pull requests fail the **DCO check** until every commit carries a valid
sign-off. There is no CLA to sign.

## Workflow

- Branch from up-to-date `main`: `f/short-description` (feature) or
  `b/short-description` (bug).
- Conventional Commits are enforced by the `commit-msg` hook — see
  `CLAUDE.md` for types and examples.
- Push and open a PR; CI must pass before merge.

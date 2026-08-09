# Workspace secrets templates

Checked-in **templates only** — no real tokens or PEMs.

Used by:

- `scripts/scaffold-workspace-secrets.sh`
- `scripts/materialize-workspace-secrets-from-1password.sh`

Human walkthrough: [`../../docs/workspace-agent-secrets.md`](../../docs/workspace-agent-secrets.md).

Edit `op/*.tpl` vault/item/field names to match your org after scaffold copies
them into `~/.config/<workspace>/op/`.

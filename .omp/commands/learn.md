---
description: Manage custom autolearn candidates (status/view/approve/reject/delete/rollback/sweep/config). Mode-gated; no DB when off/builtin.
argument-hint: "<status|view|approve|reject|delete|rollback|sweep|config> [args]"
---

# /learn

Custom autolearn (mode=custom) candidate workflow. Builtin/off modes disable learning; commands report status without creating `~/.omp/agent/learn.db`.

## Usage

- `/learn status` — counts by status for project scope
- `/learn view [candidate-id]` — list or inspect one candidate (scope-authorized)
- `/learn approve <candidate-id> <reviewed-content>` — approve with meaningful, redacted content (rejects `Verified resolution for ...`)
- `/learn reject <candidate-id>` — reject candidate
- `/learn delete <candidate-id>` — delete with tombstone (no resurrection)
- `/learn rollback <candidate-id>` — rollback trusted projection (fails if tombstoned)
- `/learn sweep` — sweep expired TTL candidates
- `/learn config` — show effective autolearn.mode and project identity

Handler: `packages/coding-agent/src/autolearn/learn-commands.ts:handleLearnCommand` enforces `resolveAutolearnMode(settings)` gating and canonical project identity (`path.resolve(repoRoot)`). Never creates DB when `mode !== custom` and file absent.

For approved candidates, projection uses real Mnemopi scoped bank derived from full canonical identity (`canonicalProjectIdentity`) via `bankForScope`; rollback/delete operate on that exact stored `mnemopi_bank`. Redaction runs before every persistence boundary. Managed skill creation from approved content must go through `writeManagedSkill` hardened path (safe name, 64k limit, symlink/atomic, audit, regression) — see `custom-service.ts:createSkillFromApprovedCandidate`.

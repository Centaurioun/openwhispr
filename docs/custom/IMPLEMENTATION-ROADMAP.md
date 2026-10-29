# OpenWhispr Custom Development — Start Here

**Approved design:** docs/superpowers/specs/2026-10-29-openwhispr-integrated-studio-design.md

**Base commit:** b9e9ebefac4b961456c269164a93ddfdd53438b9
**Stage:** isolated fork safety PR; do not merge or release before all gates are verified.

## Implementation sequence

1. **Fork integration safety:** docs/superpowers/plans/2026-10-29-01-fork-integration-safety.md. Preserve upstream baseline, establish non-destructive conflict checks, data backup and regression gates.
2. **Transcript Studio:** docs/superpowers/plans/2026-10-29-02-transcript-studio.md. Immutable source, editable overlay, speaker and AI proposals, Undo/Redo, version history, long-text integrity tests.
3. **Local read-only MCP:** docs/superpowers/plans/2026-10-29-03-local-mcp.md. Stdio adapter over authenticated local CLI bridge; no hosted Pro bypass and no mutation tools.
4. **Optional ChatGPT plan text provider:** docs/superpowers/plans/2026-10-29-04-chatgpt-plan-provider.md. Only via eligible documented authorization; do not borrow Codex tokens. Local inference must work independently.

## Review and implementation requirements

- Invoke Superpowers subagent-driven-development or executing-plans per task, in isolated worktrees, with an independent review after each task when available.
- Run a red test first, implement, rerun targeted and baseline tests, then commit small reviewable changes.
- Never change main directly, force-reset branches, deploy, publish, or touch production user-data.
- GitHub Projects, issues and milestones were intentionally deferred.
- Source transcripts remain immutable. No automatic AI edit, paid MCP circumvention, audio retranscription, or unauthorized cloud transcript upload.
- Before any native app profile migration: back up SQLite consistently (including WAL), restore and test in a disposable profile.

## First verified work

- Read-only checker: scripts/custom/check-upstream-merge.mjs.
- Targeted tests: test/helpers/customUpstreamGate.test.js.
- Fork policy: docs/custom/CONTRIBUTING-FORK.md.
- Seven isolated tests passed locally in a standalone Node v22 environment. This is **not** a full project test pass; the repository specifies Node >=24. Re-run under Node >=24 and perform full CI.
- Codex was **not** invoked automatically by the assistant session; these plans and GitHub PR are its handoff.

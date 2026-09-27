---
name: agent-host-fork
description: Use when adding code to this fork's agent-host work, syncing from upstream OpenChamber, choosing a branch, or placing new code or dependencies: the fork flow for path ownership, the develop branch, upstream merges, fork-owned dependencies, and feature flags.
---

# Agent host fork

This repository is a fork of upstream OpenChamber. Fork work has to stay a small diff against upstream while it grows. Follow this flow every time you add or change code.

[docs/agent-host/ROLLOUT.md](../../../docs/agent-host/ROLLOUT.md) holds the reasoning, the exact git commands, the conflict playbook, and the first milestone.

## The flow

1. **Classify the path before editing.** A path is either shared (upstream tracks it) or fork-owned (this fork created it). A shared path gets the smallest edit and keeps its name and location. A fork-owned path is free to grow.
   Done when: you can name the path's owner, and the edit matches it.

2. **Choose the branch.** Fork work lands on `develop`. `main` mirrors upstream and takes no commit of ours.
   Done when: HEAD is `develop` or a feature branch cut from it.

3. **Sync before a milestone, and every one to two weeks.** Fetch upstream and merge `upstream/main` into `develop`.
   Done when: `bun run type-check` and `bun run test` both pass.

4. **Place new code and dependencies.** New code goes in a fork-owned directory. A dependency only the fork needs goes in the fork-owned package's `package.json`.
   Done when: no shared `package.json` gained a dependency, and every upstream file kept its name and location.

5. **Gate new behavior behind a flag, off by default.**
   Done when: with the flag off, the OpenCode-only path is unchanged.

## Path ownership

Shared, upstream-tracked. Edit thin, keep names and locations:

- `AGENTS.md`, `CLAUDE.md`
- `packages/*` except the fork-owned paths below
- `.agents/skills/`, `.opencode/`

Fork-owned. Free to grow. Add a directory here when you create one:

- `docs/agent-host/`
- `packages/ui/src/lib/agent/`
- `packages/web/server/lib/agents/`

## Fork-only code depends on seams, not internals

Fork-only code calls the `AgentRuntime` contract and other seams this fork declares. Upstream refactors an internal without any merge conflict, so fork code that reached into an upstream internal breaks with no warning.

Done when: every import from a fork-owned file into shared code goes through a seam the fork declares.

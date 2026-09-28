# Agent host: rollout

Status: plan agreed on 2026-09-27. [DESIGN.md](DESIGN.md) says where the project is going and what the code looks like today. This file says how to build it while staying in sync with upstream OpenChamber. Owner: the maintainer.

Read this file before starting any milestone. It assumes the direction in DESIGN.md is settled and only covers how to get there. The mandatory checklist is the `agent-host-fork` skill; this file holds the reasoning and the mechanics behind it.

## Goals and constraints

Two goals have to hold at the same time:

1. Build the agent host described in DESIGN.md.
2. Keep pulling updates from upstream OpenChamber (`openchamber/openchamber`) with small conflicts.

The constraints follow from the second goal: do not break the OpenCode-only path, merge often instead of rarely, and keep the upstream test suite green after every sync.

The two goals pull against each other. A fork sync wants a small diff against upstream, and the refactor wants to edit the files upstream changes most: `packages/ui/src/lib/opencode/client.ts`, the shared UI stores and hooks, and `packages/web/server/lib/opencode/`. The branch model and the code-placement rules below exist to manage that tension.

## Branch and remote model

Add upstream once:

```
git remote add upstream https://github.com/openchamber/openchamber.git
```

- `main` is a mirror of upstream. It only fast-forwards from `upstream/main` and never takes a commit of ours. It exists so the fork can always see exactly what upstream holds.
- `develop` is the integration branch. All fork work lands here. Feature branches start from `develop` and merge back into `develop`.
- The fork's builds and releases read from `develop`, not from `main`.

If the mirror role is worth enforcing, protect `main` on `origin` so a push cannot add a commit to it by accident.

## Sync workflow

Merge `upstream/main` into `develop` every one to two weeks, or before any milestone, whichever comes first. Frequent small merges cost less than rare large ones, because this refactor lives a long time and touches high-churn files.

```
git fetch upstream
git checkout develop
git merge upstream/main
```

If `main` should follow upstream too:

```
git checkout main
git merge --ff-only upstream/main
git push origin main
```

After every merge, before doing anything else:

```
bun run type-check
bun run test
```

Both have to pass before work continues. A sync that leaves the tree red is not finished.

## Code placement

Conflict cost depends on how much the fork edits lines upstream also edits. Three rules keep that cost low:

1. New code lives in new directories. `packages/ui/src/lib/agent/` for the contract and the UI adapter, `packages/web/server/lib/agents/` for the server side. Upstream does not touch these, so they never conflict.
2. The adapter wraps `opencodeClient`, it does not rewrite it. `OpenCodeRuntime` delegates to the existing client. `client.ts` stays close to its current shape in the early milestones, so the fork's diff against upstream stays small.
3. Do not move or rename upstream files. `projection.ts`, `model.ts` and `events.ts` keep their names and locations. New domain types live beside them and re-export, rather than moving existing code.

Two more rules apply while the work grows:

4. New behavior sits behind a flag that is off by default. The OpenCode-only path is unchanged when the flag is off, so upstream tests stay green and a fault stays separate from current behavior.
5. `client.ts` is the one hot spot. Moving its domain and OpenChamber-owned logic out (the buckets in DESIGN.md) is the conflict-heavy part. Do it in small mechanical steps and pull code into new files rather than rewriting it in place. Git reports a modify/delete when upstream touches a line that moved, which is workable when the moves are small.

## Program (phases 1 to 3)

Definition of done for phases 1 to 3: the agent-domain path (chat, session, message, streaming, permission, status) runs through the `AgentRuntime` contract and the canonical model. OpenChamber-owned features and OpenCode-specific features stay in the OpenCode adapter, reachable behind capability flags. Callers migrate area by area; not every caller of `opencodeClient` has to move.

| # | Milestone | What it does | Risk |
|---|---|---|---|
| M1 | Contract and OpenCode adapter | Session lifecycle behind `AgentRuntime`, zero behavior change. Done. | Low |
| M2 | Canonical event vocabulary | Event types move to `lib/agent`. Done. | Low |
| M3 | Runtime owns translation | The adapter translates wire events; the pipeline stops importing the OpenCode event module. | Low |
| M4 | Contract breadth | Add message, prompt, cancel, permission, selection, status, fork; capability flags for optional ones. | Low |
| M5 | Migrate the agent-domain callers | Chat, session and message callers move through the seam, area by area. | Medium |
| M6 | Canonical `AgentSession` | Session becomes first-class with a runtime id and a native id; session projection moves into the adapter. | Medium |
| M7 | Canonical `AgentMessage` and `AgentPart` | Message and part projection move into the adapter; stores consume the canonical model. | High |
| M8 | Bucket 2 cleanup | Orchestration and policy leave `client.ts`. | High |
| M9 | Bucket 3 and 4 cleanup | OpenChamber-owned routes leave the client; OpenCode-specific calls sit behind capability flags. | Medium |

Order: M3, then M4, then M5, then M6 and M7, then M8 and M9. Every milestone follows the rules above: fork-owned code first, thin edits to shared files, sync often.

## Milestone M1 (done)

M1 has zero behavior change. It creates the seam and proves it with a test, and nothing a user sees changes.

In scope:

- `packages/ui/src/lib/agent/contract.ts`: the `AgentRuntime` interface, `AgentSession`, the `AgentEvent` union, and `AgentCapabilities`.
- `packages/ui/src/lib/agent/registry.ts`: resolves the runtime for a session.
- `packages/ui/src/lib/agent/opencode-runtime.ts`: the adapter that implements the contract by delegating to `opencodeClient`.
- Unit tests for the adapter: every method delegates to the right client call, the declared capabilities match the implementation, and errors map into the canonical error type.
- Migrate the smallest caller of `opencodeClient` that already has a test to go through the seam, behind a flag that defaults to the current path. The old path stays in place.

Out of scope for M1: the canonical event and session model, the server-side `AgentManager`, OMP, ACP, and any UX change.

The result is a seam that exists and is tested, with behavior unchanged and the fork's diff small.

## Validation

- After each upstream merge: `bun run type-check` and `bun run test`.
- After adding or deleting files, or changing exports: `bun run dead-code`, and read the report. It does not block, but M1 adds code few callers use yet, so it will show up there until later milestones migrate callers.
- New adapter logic gets a focused test. Static checks alone do not prove the delegation is correct.

## Conflict playbook

When a merge conflicts:

- In `client.ts` or a UI caller: resolve in place and keep both sides. Take the upstream change and keep the seam. Never drop an upstream change to make the merge easier.
- In a file the fork moved code out of: the conflict is usually a modify/delete. Keep the upstream edit and re-apply the move on top.
- In a new file under `packages/ui/src/lib/agent/` or `packages/web/server/lib/agents/`: this should not happen. If it does, upstream added a path with the same name, so pick a different name for ours.

## Risks

- `client.ts` and the UI callers will conflict on a regular cadence. The only real mitigation is frequent merges and small refactor steps.
- M1 adds code with few callers, so the dead-code report flags it. That is expected and clears as later milestones migrate callers.
- The fork pins `@opencode/client`. Upstream will bump it. The adapter is the only consumer, so a bump stays contained to the adapter.

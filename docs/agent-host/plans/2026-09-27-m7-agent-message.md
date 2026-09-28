# M7 canonical AgentMessage and AgentPart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The contract names messages and parts with `AgentMessage` and `AgentPart`. Zero behavior change.

**Architecture:** Two aliases of the domain types, plus `MessagePage` using them, re-exported from `client.ts`.

**Tech Stack:** TypeScript.

**Spec:** `docs/agent-host/M7-AGENT-MESSAGE.md`.

## Global Constraints

- Work on the `develop` branch. Never commit to `main`.
- New code lives only under fork-owned paths. This plan writes to `packages/ui/src/lib/agent/` and edits `lib/opencode/client.ts` thinly.
- No new dependencies.

---

### Task 1: Add the aliases

**Files:**
- Modify: `packages/ui/src/lib/agent/contract.ts`
- Modify: `packages/ui/src/lib/opencode/client.ts`

**Interfaces:**
- Produces: `AgentMessage = Message`, `AgentPart = Part` from `@/lib/agent/contract`, re-exported from `@/lib/opencode/client`; `MessagePage` carrying `AgentMessage` and `AgentPart`.

- [ ] **Step 1: Add the aliases and update `MessagePage`**

In `packages/ui/src/lib/agent/contract.ts`, add near `AgentSession`:

```ts
/** The canonical name for a message. Equals the domain model while one runtime exists. */
export type AgentMessage = Message
/** The canonical name for a message part. Equals the domain model while one runtime exists. */
export type AgentPart = Part
```

Change `MessagePage`:

```ts
export type MessagePage = {
  items: Array<{ info: AgentMessage; parts: AgentPart[] }>
  cursor: { previous?: string; next?: string }
}
```

- [ ] **Step 2: Re-export from the client**

In `packages/ui/src/lib/opencode/client.ts`, add `AgentMessage` and `AgentPart` to the `@/lib/agent/contract` import and to the re-export list.

- [ ] **Step 3: Verify**

Run: `bun run --cwd packages/ui type-check`
Run: `bun run --cwd packages/ui test`
Expected: no errors, and the two known upstream failures only.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/agent/contract.ts packages/ui/src/lib/opencode/client.ts
git commit -m "feat(agent): name messages and parts in the contract"
```

---

### Task 2: Update the module documentation

**Files:**
- Modify: `packages/ui/src/lib/agent/DOCUMENTATION.md`

- [ ] **Step 1: Document the aliases**

Add to `## Rules`:

```markdown
- `AgentMessage` and `AgentPart` are the contract's names for messages and parts. They equal the domain model while one runtime exists.
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/lib/agent/DOCUMENTATION.md
git commit -m "docs(agent): document the message vocabulary"
```

---

## Self-Review

- Spec coverage: the spec asks for the two aliases, the `MessagePage` change, and the re-export. Task 1 covers each; Task 2 documents it. Projection stays put, matching the spec's deferral.
- Placeholder scan: no TBD.
- Type consistency: `AgentMessage` and `AgentPart` keep one meaning across contract, client and the doc.

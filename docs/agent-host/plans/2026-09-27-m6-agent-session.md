# M6 canonical AgentSession Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A projected session carries its runtime id and native session id, and `AgentSession` names that shape. Zero behavior change.

**Architecture:** `AgentSession` is a superset of `Session` defined in `lib/agent/contract.ts`. `projectSession` stamps the two fields. Four `opencodeClient` methods and the matching adapter methods return `AgentSession`. `Session` and its consumers are untouched.

**Tech Stack:** TypeScript, `bun:test`.

**Spec:** `docs/agent-host/M6-AGENT-SESSION.md`.

## Global Constraints

- Work on the `develop` branch. Never commit to `main`.
- New code lives only under fork-owned paths. This plan writes to `packages/ui/src/lib/agent/` and edits `lib/opencode/projection.ts` and `lib/opencode/client.ts` thinly.
- No new dependencies.
- `lib/opencode/projection.ts` imports `AgentSession` from `@/lib/agent/contract`; the contract never imports the OpenCode client module.
- After each task: `bun run --cwd packages/ui type-check` and `bun run --cwd packages/ui test`, holding at the two known upstream failures.

---

### Task 1: AgentSession and its producers

**Files:**
- Modify: `packages/ui/src/lib/agent/contract.ts`
- Modify: `packages/ui/src/lib/agent/opencode-runtime.ts`
- Modify: `packages/ui/src/lib/opencode/projection.ts`
- Modify: `packages/ui/src/lib/opencode/client.ts`
- Test: `packages/ui/src/lib/opencode/projection.test.ts`
- Test: `packages/ui/src/lib/agent/opencode-runtime.test.ts`

**Interfaces:**
- Produces: `AgentSession = Session & { runtimeId: string; nativeSessionId: string }` from `@/lib/agent/contract`, re-exported from `@/lib/opencode/client`; `projectSession(info): AgentSession`; the session-returning `opencodeClient` and `AgentRuntime` methods typed `AgentSession`.

- [ ] **Step 1: Add the failing projection assertions**

In `lib/opencode/projection.test.ts`, inside the `projectSession` describe block, add:

```ts
  test("names the owning runtime and the native session id", () => {
    const session = projectSession(sessionInfo)
    expect(session.runtimeId).toBe("opencode")
    expect(session.nativeSessionId).toBe("ses_1")
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/lib/opencode/projection.test.ts`
Expected: FAIL, `runtimeId` is undefined.

- [ ] **Step 3: Define `AgentSession` in the contract**

In `packages/ui/src/lib/agent/contract.ts`, add after the `MoveSessionOptions` type:

```ts
/** A session together with the runtime that owns it and that runtime's own session id. */
export type AgentSession = Session & {
  runtimeId: string
  nativeSessionId: string
}
```

Change these four `AgentRuntime` methods to return `AgentSession`:
- `createSession(params?: CreateSessionParams, directory?: string | null): Promise<AgentSession>`
- `getSession(id: string, directory?: string | null): Promise<AgentSession>`
- `listSessions(directory?: string | null): Promise<AgentSession[]>`
- `forkSession(sessionId: string, options?: { before?: string; directory?: string | null }): Promise<AgentSession>`

- [ ] **Step 4: Stamp the fields in `projectSession`**

In `lib/opencode/projection.ts`, add to the imports:

```ts
import type { AgentSession } from "@/lib/agent/contract"
```

Change the signature and the returned object:

```ts
export function projectSession(info: SessionInfo): AgentSession {
  return compact({
    id: info.id,
    runtimeId: "opencode",
    nativeSessionId: info.id,
    parentID: info.parentID,
    ...
```

Keep every other field as it is.

- [ ] **Step 5: Widen the `opencodeClient` return types**

In `lib/opencode/client.ts`, add `AgentSession` to the `@/lib/agent/contract` import and to the re-export list.

Change the return type of `createSession`, `getSession`, `listSessions` and `forkSession` from `Promise<Session>` / `Promise<Session[]>` to `Promise<AgentSession>` / `Promise<AgentSession[]>`.

- [ ] **Step 6: Update the adapter**

In `lib/agent/opencode-runtime.ts`, import `AgentSession` from `./contract`, and change `createSession`, `getSession`, `listSessions` and `forkSession` return types to `AgentSession` / `AgentSession[]`.

- [ ] **Step 7: Update the adapter test fixture**

In `lib/agent/opencode-runtime.test.ts`, add the two fields to `sessionFixture`:

```ts
const sessionFixture: AgentSession = {
  id: "ses_1",
  runtimeId: "opencode",
  nativeSessionId: "ses_1",
  projectID: "p",
  ...
```

Import `AgentSession` from `./contract` and type the fixture with it.

- [ ] **Step 8: Run the tests and type-check**

Run: `bun test src/lib/opencode/projection.test.ts`
Run: `bun test src/lib/agent/opencode-runtime.test.ts`
Run: `bun run --cwd packages/ui type-check`
Expected: PASS and no errors.

- [ ] **Step 9: Run the full suite**

Run: `bun run --cwd packages/ui test`
Expected: the two known upstream failures only.

- [ ] **Step 10: Commit**

```bash
git add packages/ui/src/lib/agent/contract.ts packages/ui/src/lib/agent/opencode-runtime.ts packages/ui/src/lib/agent/opencode-runtime.test.ts packages/ui/src/lib/opencode/projection.ts packages/ui/src/lib/opencode/projection.test.ts packages/ui/src/lib/opencode/client.ts
git commit -m "feat(agent): give sessions a runtime and native id"
```

---

### Task 2: Update the module documentation

**Files:**
- Modify: `packages/ui/src/lib/agent/DOCUMENTATION.md`

- [ ] **Step 1: Document AgentSession**

Add to `## Files`:

```markdown
- `contract.ts` also defines `AgentSession`, a `Session` that names its runtime and native session id.
```

Add to `## Rules`:

```markdown
- A projected session carries `runtimeId` and `nativeSessionId`. Stores keep the base `Session` type; code that needs the runtime identity types as `AgentSession`.
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/lib/agent/DOCUMENTATION.md
git commit -m "docs(agent): document AgentSession"
```

---

## Self-Review

- Spec coverage: the spec asks for the superset type, the `projectSession` stamp, the four widened return types on both the client and the adapter, and the re-export. Task 1 covers each; Task 2 documents it. Stores and fixtures stay untouched, matching the spec.
- Placeholder scan: no TBD; every edit carries the exact code.
- Type consistency: `AgentSession` keeps one shape across contract, adapter, projection, client and the adapter test.

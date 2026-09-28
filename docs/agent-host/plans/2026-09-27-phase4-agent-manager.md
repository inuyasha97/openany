# Phase 4 AgentManager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The registry resolves a runtime by id. Zero behavior change.

**Architecture:** `registry.ts` holds a map of runtimes keyed by `runtime.id`, plus a lazily built OpenCode default. `getAgentRuntime(runtimeId?)` resolves by id.

**Tech Stack:** TypeScript, `bun:test`.

**Spec:** `docs/agent-host/PHASE4-AGENT-MANAGER.md`.

## Global Constraints

- Work on the `develop` branch. Never commit to `main`.
- New code lives only under fork-owned paths. This plan writes only to `packages/ui/src/lib/agent/`.
- No new dependencies.
- No contract change, no pipeline change.

---

### Task 1: Make the registry a manager

**Files:**
- Modify: `packages/ui/src/lib/agent/registry.ts`
- Test: `packages/ui/src/lib/agent/registry.test.ts`

**Interfaces:**
- Produces: `getAgentRuntime(runtimeId?: string): AgentRuntime`, `registerAgentRuntime(runtime: AgentRuntime): void`, `clearAgentRuntimes(): void`. `setAgentRuntime` is removed.

- [ ] **Step 1: Write the failing test**

Replace `packages/ui/src/lib/agent/registry.test.ts` with:

```ts
import { afterEach, describe, expect, test } from "bun:test"
import { OpenCodeRuntime } from "./opencode-runtime"
import { clearAgentRuntimes, getAgentRuntime, registerAgentRuntime } from "./registry"

afterEach(() => clearAgentRuntimes())

describe("agent runtime registry", () => {
  test("defaults to the OpenCode runtime", () => {
    expect(getAgentRuntime().id).toBe("opencode")
  })

  test("returns the runtime registered for an id", () => {
    const custom = new OpenCodeRuntime()
    registerAgentRuntime(custom)
    expect(getAgentRuntime("opencode")).toBe(custom)
    expect(getAgentRuntime()).toBe(custom)
  })

  test("falls back to the default runtime for an unregistered id", () => {
    expect(getAgentRuntime("omp").id).toBe("opencode")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/lib/agent/registry.test.ts`
Expected: FAIL, `clearAgentRuntimes` and `registerAgentRuntime` do not exist.

- [ ] **Step 3: Rewrite `registry.ts`**

Replace `packages/ui/src/lib/agent/registry.ts` with:

```ts
import type { AgentRuntime } from "./contract"
import { OpenCodeRuntime } from "./opencode-runtime"

const DEFAULT_RUNTIME_ID = "opencode"

const registeredRuntimes = new Map<string, AgentRuntime>()
let cachedDefault: AgentRuntime | null = null

/**
 * The runtime for an id. A registered runtime wins; otherwise the OpenCode
 * runtime is built once and returned. Resolved at call time so a runtime
 * switch is never cached across endpoints.
 */
export const getAgentRuntime = (runtimeId: string = DEFAULT_RUNTIME_ID): AgentRuntime => {
  const registered = registeredRuntimes.get(runtimeId)
  if (registered) return registered
  cachedDefault ??= new OpenCodeRuntime()
  return cachedDefault
}

export const registerAgentRuntime = (runtime: AgentRuntime): void => {
  registeredRuntimes.set(runtime.id, runtime)
}

export const clearAgentRuntimes = (): void => {
  registeredRuntimes.clear()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/lib/agent/registry.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Type-check and run the full suite**

Run: `bun run --cwd packages/ui type-check`
Run: `bun run --cwd packages/ui test`
Expected: no errors, and the two known upstream failures only.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/agent/registry.ts packages/ui/src/lib/agent/registry.test.ts
git commit -m "feat(agent): resolve runtimes by id in the registry"
```

---

### Task 2: Update the module documentation

**Files:**
- Modify: `packages/ui/src/lib/agent/DOCUMENTATION.md`

- [ ] **Step 1: Document the manager**

Change the `registry.ts` bullet in `## Files` to:

```markdown
- `registry.ts` holds the runtime manager: `getAgentRuntime(runtimeId?)`, `registerAgentRuntime()`, `clearAgentRuntimes()`. A registered runtime wins by id; otherwise the OpenCode runtime is built once. Resolved at call time, never cached across endpoints.
```

- [ ] **Step 2: Commit**

```bash
git add packages/ui/src/lib/agent/DOCUMENTATION.md
git commit -m "docs(agent): document the runtime manager"
```

---

## Self-Review

- Spec coverage: the spec asks for the three manager functions, the default id, the fallback, and removing `setAgentRuntime`. Task 1 covers each; Task 2 documents it. No contract or pipeline change, matching the spec.
- Placeholder scan: no TBD.
- Type consistency: `getAgentRuntime`, `registerAgentRuntime`, `clearAgentRuntimes` keep one signature across registry, test and doc.

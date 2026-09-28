# M6: canonical AgentSession

Status: design agreed on 2026-09-27. Sixth milestone of the program in [ROLLOUT.md](ROLLOUT.md). Zero behavior change.

## Goal

A session carries its runtime identity. After M6, a projected session names the runtime that owns it and that runtime's own session id, and `AgentSession` is the canonical name for a session that has them.

## Shape

`AgentSession` is a superset of the existing `Session`:

```ts
export type AgentSession = Session & {
  runtimeId: string
  nativeSessionId: string
}
```

`Session` stays the base type every store and caller already uses, so no store or test fixture changes. Code that needs the runtime identity types as `AgentSession`.

For OpenCode, `runtimeId` is `"opencode"` and `nativeSessionId` equals the domain id. A later runtime sets its own.

## Producers

`projectSession` in `lib/opencode/projection.ts` returns `AgentSession` and stamps both fields. The session-returning methods on `opencodeClient` (`createSession`, `getSession`, `listSessions`, `forkSession`) change their return type to `AgentSession`, so the identity survives to callers.

`SessionPage` keeps `sessions: Session[]`; an `AgentSession[]` is assignable to it.

`AgentSession` is defined in `lib/agent/contract.ts` and re-exported from `lib/opencode/client.ts`, following the M2 to M5 pattern.

## Dependency direction

```
lib/opencode/projection.ts  -->  lib/agent/contract.ts   (returns AgentSession)
lib/agent/contract.ts  -->  lib/opencode/model.ts        (Session base)
```

## What does not change

- `Session` and every store typed with it.
- `SessionPage`, optimistic session construction, and the test fixtures that build a plain `Session`.
- No behavior change: the projected object gains two fields.

## Verification

- `lib/opencode/projection.test.ts` asserts `runtimeId` and `nativeSessionId`.
- The adapter fixture in `lib/agent/opencode-runtime.test.ts` becomes an `AgentSession`.
- `bun run --cwd packages/ui type-check` and `bun run --cwd packages/ui test`, holding at the two known upstream failures.

## Risks

- `lib/opencode/projection.ts` and `lib/opencode/client.ts` are upstream-tracked. The edits are a return-type change plus two fields.
- The two new fields travel into every session record. Nothing reads them yet; they exist for the AgentManager.

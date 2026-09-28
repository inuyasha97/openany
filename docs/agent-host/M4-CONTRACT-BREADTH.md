# M4: contract breadth

Status: design agreed on 2026-09-27. Fourth milestone of the program in [ROLLOUT.md](ROLLOUT.md). Follows the M1 rule: establish the seam with zero behavior change.

## Goal

The `AgentRuntime` contract carries the agent-domain operations the chat, session, message and permission paths need, so M5 is only caller edits. No caller migrates in M4.

## Naming

Hybrid. Ten methods take an agent-neutral name; the rest keep the `opencodeClient` name, which is already neutral enough.

| Contract name | `opencodeClient` name |
|---|---|
| `getMessages` | `getSessionMessages` |
| `cancel` | `abortSession` |
| `replyPermission` | `replyToPermission` |
| `getPermission` | `fetchPermission` |
| `listPermissions` | `listPendingPermissions` |
| `selectModel` | `switchSessionModel` |
| `selectAgent` | `switchSessionAgent` |
| `getActiveStatus` | `getActiveSessionStatuses` |
| `replyForm` | `replyToForm` |

Keeping the other names (`forkSession`, `listAgents`, `listCommands`, `listMcpServers`, `connectMcpServer`, `disconnectMcpServer`, `listSkills`, `cancelForm`, `listPendingForms`, `stageRevert`, `commitRevert`, `clearRevert`, `getSessionTurnDiff`) avoids needless renames in M5.

## Methods added

Core (always present):

- `getMessages(id, options?, directory?)` -> `MessagePage`
- `cancel(id, directory?)` -> `boolean`
- `replyPermission(sessionID, requestID, reply, options?)` -> `boolean`
- `getPermission(sessionID, requestID, directory?)` -> `FetchPermissionResult`
- `listPermissions(options?)` -> `PermissionRequest[]`
- `selectModel(id, model, directory?)` -> `void`
- `selectAgent(id, agent, directory?)` -> `void`
- `getActiveStatus(directory?)` -> `Record<string, SessionStatus> | null`

Optional (declared with `?`, gated by capabilities):

- `forkSession(sessionId, options?)` -> `Session`
- `listAgents(directory?)` -> `Agent[]`
- `listCommands(directory?, signal?)` -> `Command[]`
- `listMcpServers(directory?)` -> `McpServerStatus[]`
- `connectMcpServer(server, directory?)` -> `void`
- `disconnectMcpServer(server, directory?)` -> `void`
- `listSkills(directory?)` -> `Skill[]`
- `replyForm(sessionID, formID, answer, directory?)` -> `boolean`
- `cancelForm(sessionID, formID, directory?)` -> `boolean`
- `listPendingForms(options?)` -> `FormInfo[]`
- `stageRevert(sessionId, messageId, options?)` -> `SessionRevert`
- `commitRevert(sessionId, directory?)` -> `void`
- `clearRevert(sessionId, directory?)` -> `void`
- `getSessionTurnDiff(sessionId, options?)` -> `FileDiffInfo[]`

`sendPrompt` and `sendCommand` are deferred to M5, where the chat caller shapes them.

Optional methods are optional on the type, so a future adapter that lacks one does not have to fake it. Callers gate on the capability and use an optional call.

## Capabilities added

`AgentCapabilities` gains `forms`, `revert`, `turnDiff` and `skills`. All are `true` for OpenCode. The existing `permissions`, `agents`, `commands`, `mcp` already cover their groups.

## Types

`MessagePage` and `FetchPermissionResult` currently live in `lib/opencode/client.ts`. They move to `lib/agent/contract.ts` as the canonical definitions, and `lib/opencode/client.ts` re-exports them so every consumer keeps compiling. This keeps the dependency direction correct: the contract does not import the OpenCode client module.

## Adapter

`OpenCodeRuntime` implements every new method by delegating to the injected client. `SessionClient` extends its `Pick` list to cover all of them. `OPENCODE_CAPABILITIES` gains the four new flags.

## Verification

- Adapter delegation test: calling each contract method records the matching client method.
- `bun run --cwd packages/ui type-check` passes, proving the adapter satisfies the contract.
- `packages/ui/src/lib/opencode/client.test.ts` and the existing suites still pass with the same known upstream failures, none new.

## Risks

- `lib/opencode/client.ts` and `lib/opencode/model.ts` are upstream-tracked. The edit to `client.ts` is a type move plus a re-export.
- Adding 22 methods with no caller yet is deliberate dead code, cleared as M5 migrates callers.

# M5: migrate the agent-domain callers

Status: design agreed on 2026-09-27. Fifth milestone of the program in [ROLLOUT.md](ROLLOUT.md).

## Goal

The agent-domain path runs through `AgentRuntime`. After M5, the chat, session, message, permission, form, revert and catalog calls read from the contract instead of `opencodeClient`. OpenChamber-owned and OpenCode-specific calls keep using `opencodeClient`.

## Access

- React components and hooks use `useAgentRuntime()`, a new registry-backed hook at `packages/ui/src/lib/agent/use-agent-runtime.ts`. It wraps `getAgentRuntime()`, so a component consumes a hook, not the module global. A provider is deferred until the AgentManager picks a runtime per session.
- Plain modules use `getAgentRuntime()` directly.

## Inventory

From the caller inventory: 53 files touch `opencodeClient`, 205 call sites, 81 of them agent-domain.

- 9 files are entirely agent-domain (3 React, 6 plain).
- 9 files mix agent-domain and non-agent-domain calls. They keep the `opencodeClient` import for the non-domain calls.
- 35 files have no agent-domain call and do not change.

Files and call sites:

| File | React | Agent-domain call sites |
|---|---|---|
| `lib/btw.ts` | no | `forkSession`, `getSessionMessages` |
| `lib/multirun/keep.ts` | no | `listSessionsPage`, `getSession` |
| `lib/multirun/laneData.ts` | no | `getSessionMessages` x2 |
| `lib/reviewFlow.ts` | no | `sendMessage`, `getSession` x5, `createSession`, `deleteSession` |
| `stores/useMcpStore.ts` | no | `listMcpServers`, `connectMcpServer` x2, `disconnectMcpServer` x2 |
| `sync/vscode-permission-auto-accept.ts` | no | `getSession`, `listPendingPermissions`, `fetchPermission` |
| `lib/multirun/fusion.ts` | no | `getSession`, `sendMessage` |
| `stores/useAgentsStore.ts` | no | `listAgents` |
| `stores/useCommandsStore.ts` | no | `listCommands` |
| `stores/useConfigStore.ts` | no | `listAgents` |
| `stores/useGlobalSessionsStore.ts` | no | `listSessionsPage` |
| `sync/bootstrap.ts` | no | `getActiveSessionStatuses`, `listPendingForms`, `listPendingPermissions` |
| `sync/session-actions.ts` | no | `moveSession`, `abortSession` x3, `getSessionMessages` x3, `stageRevert` x2, `getSession` x10, `commitRevert` x2, `clearRevert` x2, `createSession`, `deleteSession` x2, `getActiveSessionStatuses`, `renameSession`, `replyToPermission` x2, `replyToForm`, `cancelForm`, `forkSession` x2 |
| `sync/session-ui-store.ts` | no | `listCommands`, `sendCommand`, `sendMessage` |
| `components/views/DiffView.tsx` | yes | `getSessionTurnDiff` |
| `sync/use-session-ai-rename.ts` | yes | `getSession` x2 |
| `sync/use-sync.ts` | yes | `getSession` |
| `sync/sync-context.tsx` | yes | `getActiveSessionStatuses` x3, `listPendingForms`, `listPendingPermissions`, `getSession` x2, `listAgents`, `listSessionsPage` |

## Contract additions

- `sendPrompt(params)` mirrors `opencodeClient.sendMessage` params. The orchestration stays inside the client; M8 cleans it.
- `sendCommand(params)` mirrors `opencodeClient.sendCommand` params.
- `listSessionsPage(options?)` returns `SessionPage`. Three callers need it and the contract has none.

`SendPromptParams`, `SendCommandParams`, `FileInputLite`, `SkillMentions`, `SessionPage` and `SessionListOptions` move from `lib/opencode/client.ts` to `lib/agent/contract.ts`, and `client.ts` re-exports them. This keeps the dependency direction correct.

## Rename rule

Migrated calls rename the ten hybrid methods:

| `opencodeClient` | contract |
|---|---|
| `getSessionMessages` | `getMessages` |
| `abortSession` | `cancel` |
| `replyToPermission` | `replyPermission` |
| `fetchPermission` | `getPermission` |
| `listPendingPermissions` | `listPermissions` |
| `switchSessionModel` | `selectModel` |
| `switchSessionAgent` | `selectAgent` |
| `getActiveSessionStatuses` | `getActiveStatus` |
| `replyToForm` | `replyForm` |
| `sendMessage` | `sendPrompt` |

Every other migrated call keeps its name.

## What does not change

- The 35 files with no agent-domain call.
- Non-agent-domain calls in mixed files (`getSdkClient`, `getDirectory`, `setDirectory`, `getConfig`, `clearConfigCache`, `checkHealth`, `probeHealth`, `getProvidersForConfig`, `listProjects`, `getLocation`, `getVcs`, `getFilesystemHome`, `getDirectoryAvailability`, `shellSession`, `compactSession`, and the rest).
- The send orchestration inside `client.sendMessage`.

## Verification

- `bun run --cwd packages/ui type-check` after each task.
- `bun run --cwd packages/ui test` after each task, holding at the two known upstream failures, none new.
- The adapter delegation test covers the three new contract methods.

## Risks

- Every migrated file is upstream-tracked. Mixed files change only their agent-domain lines; entirely-agent files change the import too.
- `sync-context.tsx` (3852 lines) and `session-actions.ts` (2623 lines) are the largest edits. Both are on the critical sync path, so each gets its own task with the full suite run after it.

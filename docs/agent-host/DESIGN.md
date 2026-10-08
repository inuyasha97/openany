# Agent host: direction

Status: direction note, written 2026-09-27. This is not an agreed design and nothing here is built. The second half of this file describes the code as it stands today. Owner: the maintainer.

Update (2026-10-08): ACP was dropped as a runtime and removed from the tree. The
`packages/acp-adapter/` package, the `packages/web/server/lib/agents/acp-*`
modules and their `/api/agents/acp/*` routes, and the UI's `openchamber:acp`
bridge frame are all gone; OMP is the only runtime the contract targets beyond
the native one. Every mention of ACP below is part of the historical direction
note and no longer describes the code. [PHASE6-ACP.md](PHASE6-ACP.md) was deleted
with it.

Read this file to share one picture of where the project is going and what the current coupling looks like. Nothing in it authorizes a change. [ROLLOUT.md](ROLLOUT.md) says how to build it while staying in sync with upstream OpenChamber.

## What this is about

OpenChamber today is an application and UI platform on top of one agent runtime, OpenCode. Chat, sessions, permissions, tool calls and messages all travel through `@opencode/client`. That single integration is both the strength and the limit. It is why the product runs deep on OpenCode, and why it cannot run a second agent at all.

The direction is to make OpenChamber an agent host: one application, one shared UI, sitting above a small contract that several agent runtimes implement. OpenCode stays the first and native runtime. Oh My Pi (OMP) and any ACP-compatible agent become further runtimes behind the same contract, added without a second copy of the UI.

## Why now

The coupling is real, not theoretical. In this repository:

- `packages/ui/src/lib/opencode/client.ts` is the one path every official OpenCode call takes. It is 2010 lines and it does two jobs at once: it wraps the SDK, and it holds OpenChamber domain decisions.
- `packages/web/server/lib/opencode/` boots, proxies and manages the OpenCode process. Its largest files (`lifecycle.js`, `env-runtime.js`, `core-routes.js`) are each around 40 to 50 KB.
- There is no agent abstraction anywhere in `packages/ui/src` or `packages/web/server`. `AgentRuntime` and ACP do not exist yet. This is a green field.
- The pinned OpenCode client is `@opencode/client` 2.0.18 and `@opencode/schema` 2.0.18.

The repo already separates OpenCode API calls (`opencodeClient`) from OpenChamber-owned capabilities (`RuntimeAPIs`, `runtimeFetch`). That split is the seam this direction extends: today it separates "OpenCode" from "OpenChamber", and the goal is to widen it to "any agent" from "OpenChamber".

## Target shape

```
                    OpenChamber
                         |
                  AgentManager
                         |
              AgentRuntime contract
                         |
     +-------------------+-------------------+
     |                   |                   |
OpenCodeRuntime      OMPRuntime         ACPRuntime
     |                   |                   |
@opencode/client   OMP SDK / RPC       ACP client
     |                   |                   |
  OpenCode              OMP          OMP / Claude / Gemini / ...
```

The layers above stay as they are: surfaces (desktop, web, VS Code, mobile), shared UI in `packages/ui`, the OpenChamber backend in `packages/web`, and OpenChamber-owned capabilities (filesystem, git, PTY, relay, tunnel, pairing). The new part is the contract between shared UI and whatever agent runs underneath.

## Integration surfaces

OpenCode is reached one way today: the SDK. OMP exposes three, and they are not interchangeable.

| | SDK | RPC | ACP |
|---|---|---|---|
| Process | in-process | separate process | separate process |
| OMP-specific | yes | yes | no |
| Reach into OMP | highest | high | limited to the protocol |
| Isolation | no | yes | yes |
| Swap the agent | no | no | yes |

SDK is the path for a deep, native integration with one runtime. ACP is the path for reaching a whole ecosystem of agents. They serve different jobs, so a host wants both, and neither replaces the other.

## The contract

Three pieces carry the abstraction.

`AgentRuntime` is the primitive set every adapter implements. From the current client surface (see the teardown) the core is:

```
createSession, listSessions, getSession, deleteSession, renameSession, moveSession
getMessages, sendPrompt, cancel
replyPermission, getPermission, listPermissions
selectModel, selectAgent
subscribe(sessionId) -> AgentEvent
getActiveStatus
```

Everything that not every agent supports is a capability flag rather than a method the UI assumes: fork, commands, MCP, agents, skills, forms, revert, turn diff. The UI renders from the capability, not from a runtime name.

`AgentSession` is a first-class domain object with its own id, a runtime id, and the runtime's native session id kept as a field. The domain id is never silently an OpenCode session id.

`AgentEvent` is one canonical event stream. OpenCode events, ACP notifications and OMP RPC frames are projected into it, and the UI sees only the canonical form.

## Decisions taken so far

1. Native OpenCode adapter first. Phase 1 keeps OpenCode behavior identical and only moves the code behind a contract.
2. ACP is one adapter, not a mandatory layer between OpenChamber and every agent. OpenCode does not have to travel through ACP.
3. Capabilities, not `if runtime === "opencode"`. A missing feature is a declared capability, and the UI hides the affordance.
4. The hard part is not the ACP client. It is pulling OpenCode assumptions out of the shared UI and out of the session, message, permission and tool model.
5. Do not start with an OMP adapter. Start with the contract, keep OpenCode running through it unchanged, then add OMP.

## Phases

1. Extract the contract, wrap `opencodeClient` as `OpenCodeRuntime`. No UX change.
2. Canonical event model.
3. Canonical session and message model.
4. `AgentManager` that can pick a runtime per session.
5. OMP through its SDK.
6. ACP runtime for OMP, Claude, Gemini and the rest.

## Open questions

- Which surface owns directory scoping once more than one runtime exists. OpenCode uses a header, other agents use cwd or their own config.
- Where the model and provider catalog lives. OpenCode manages its own, OMP manages its own, and the host should not become a shared provider manager on day one.
- Whether the raw SDK clients now exported from the UI (`getSdkClient`, `getScopedSdkClient`) can be removed from the domain surface, which needs a list of their callers first.

## Current surface: teardown of `packages/ui/src/lib/opencode/client.ts`

This is the inventory that the contract above has to be built from. The file exports one singleton, `opencodeClient`, with about 66 public methods plus private helpers. Every method falls into one of four buckets.

The buckets mean:

- Keep in runtime: a primitive every adapter implements.
- Move to agent domain: a decision that belongs above the adapter, currently sitting in the SDK wrapper.
- OpenChamber-owned: not the agent runtime's job at all.
- OpenCode-specific: stays in the OpenCode adapter behind a capability flag, with no generic contract.

### Keep in runtime

These form the `AgentRuntime` core. Their OpenCode implementation uses `x-opencode-directory` scoping and the tagged-error decode, but the method itself is runtime-neutral.

| Method | Note |
|---|---|
| `setDirectory`, `getDirectory`, `withDirectory` | directory scoping is a domain idea; the header is an OpenCode detail |
| `getBaseUrl`, `reconnectToRuntimeBaseUrl`, `assertRuntimeUnchanged` | transport shell and the runtime-switch guard |
| `listSessionsPage`, `listSessions`, `createSession`, `getSession`, `deleteSession`, `renameSession`, `moveSession` | session lifecycle |
| `getSessionMessages`, `getSessionMessage` | message reads |
| `sendMessage` | prompt core, with its orchestration split out (see below) |
| `abortSession` | cancel |
| `replyToPermission`, `fetchPermission`, `listPendingPermissions` | permission core |
| `switchSessionModel`, `switchSessionAgent` | model and agent selection |
| `getActiveSessionStatuses` | busy state, though the route behind it is OpenCode's |
| `forkSession`, `listAgents`, `listCommands`, `listMcpServers`, `connectMcpServer`, `disconnectMcpServer` | optional primitives, each behind a capability flag |
| `createRuntimeOpencodeClient`, `normalizeOpencodeError`, `OpencodeApiError` | implementation stays in the adapter; the contract exposes a canonical error above it |

### Move to agent domain

Logic that decides domain behavior and should not live in an SDK wrapper.

| Item | Note |
|---|---|
| `projectSession`, `projectMessages`, `projectProject`, `projectVcs`, `projectAgent`, `mergeConfigDocuments` | wire-to-domain projection, currently called inside the client |
| `sendMessage` orchestration | context sent as synthetic messages, skill attach and fallback retry, provider circuit breaker |
| `resolveSkillMentions` | mention-to-id policy |
| `toPromptFile`, `normalizeFilePart`, `convertHeicToJpeg` | file pre-processing |
| `uniqueDirectories`, `dedupeById`, `pageCursor`, last-page `next` trimming | pagination policy |
| `isAutoModel` and the Auto strip in `createSession` | OpenChamber sentinel, not an OpenCode model |
| `getSystemInfo` | home and username heuristic, pure domain that happens to read `location` |
| `assertProviderCircuitClosed`, `recordProviderError`, `recordProviderSuccess` | circuit breaker at the domain layer |

### OpenChamber-owned

Not the agent runtime's business.

| Method | Route |
|---|---|
| `createDirectory`, `cloneRepository`, `listLocalDirectory`, `getFilesystemHome`, `getFilesystemHomeInfo` | `/api/fs/*`, plus the desktop files API |
| `probeDirectory`, `getDirectoryAvailability` | `/api/fs/directory-stat` |
| `setOpenCodeWorkingDirectory` | `/api/opencode/directory` (lifecycle) |
| `getHostSessionStatusSnapshot` | `/api/sessions/status`, tracked by the host from the upstream event stream |
| `getWebServerSessionActivity` | `/api/session-activity` |
| `probeHealth`, `checkHealth` | `/api/opencode/health`, a gateway health check |

### OpenCode-specific

Stays in `OpenCodeRuntime`, exposed through a capability flag.

| Method | Why it is not generic |
|---|---|
| `getLocation`, `getCurrentProject` | Location route; `getCurrentProject` is a 2.0.8 shim over it |
| `getConfig`, `clearConfigCache` | merges OpenCode config documents |
| `getProviders`, `getProvidersForConfig` | provider and model catalog owned by OpenCode |
| `listSkills` | skills are an OpenCode concept |
| `searchFiles` | OpenCode's file index (`file.find`) |
| `shellSession` | `session.shell` |
| `generateSessionText`, `generateText` | `session.generate` and `generate.text` |
| `stageRevert`, `commitRevert`, `clearRevert` | revert semantics differ across agents |
| `compactSession` | `session.compact` |
| `sendCommand` | command templates expand on the OpenCode server |
| `createPermission` | programmatic `permission.create`, with no ACP equivalent |
| `replyToForm`, `cancelForm`, `listPendingForms` | forms are their own capability |
| `getSessionTurnDiff` | diff from OpenCode turn snapshots |
| `OPENCODE_DIRECTORY_HEADER`, `STATUS_BY_TAG`, `toOpencodeClientRoot` | wire details |
| `getSdkClient`, `getScopedSdkClient` | raw SDK leak, should leave the domain surface |

### Findings from the teardown

- `getActiveSessionStatuses` mixes a domain concept (a busy map) with an OpenCode route (`session.active`). The domain should keep the map and the adapter should keep the route.
- `getSdkClient` and `getScopedSdkClient` hand the raw SDK to callers. Before removing them from the domain surface, list their callers.
- `client.ts` is the seam to cut, but the projection functions in `projection.ts` are already the domain layer in disguise. Pulling them above the adapter is most of phase 3.

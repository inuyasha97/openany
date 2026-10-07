# Small Model

Background LLM calls for OpenChamber's own features — session titles, goal
distillation, session assist, the changes walkthrough. The OMP runtime is the
only agent runtime. It has no one-shot generate, so every call runs through a
throwaway session that is opened for the call and always deleted after it.

## Security boundary

The client sends a prompt. This server forwards it to the runtime, which owns
the credentials, the provider dispatch and the token refresh. Routes live under
`/api/*` and are gated by the ui-auth middleware like every other runtime API.
No credential is ever handled here.

## Files

- `client.js` — the model catalog, read from the OMP runtime host
  (`getOmpRuntimeHost()` in `../agents/omp-host-access.js`, wired globally from
  `server/index.js`). OMP's `listModels()` already excludes providers it has no
  credential for, and it reports neither a provider list nor a default model,
  so `listProviderInfos`/`getDefaultModelInfo` have no counterpart and are gone.
  `listModelInfos()` maps each OMP entry (`{ id, provider, contextWindow,
  maxTokens, input, requestModelId, name }`) into the domain model shape and
  caches it for 30 seconds; an unmounted runtime answers `null`, a failing one
  keeps the previous answer rather than retracting it.
  `configureOpenCodeRuntimeProviders` is a compatibility no-op (the host is
  global); `resetOpenCodeRuntimeProviders` drops the cache on a runtime restart.
- `index.js` — `generateSmallModelText()`, `describeSmallModel()`,
  `listAuthenticatedProviders()`.
- `routes.js` — `GET /api/small-model` (resolution preview) and
  `POST /api/small-model/generate` (`{ prompt, system?, maxOutputTokens?,
  model?, directory? }` → `{ text, providerID, modelID, source }`).

## Generation

OpenChamber's background generation ran on OpenCode's one-shot
`POST /api/experimental/generate`. OMP has no equivalent, so
`generateSmallModelText` opens a session for the call:

1. Resolve the model (below). No runtime or no model → `404`
   `No small model available — …`.
2. `createSession({ cwd })` with the caller's `directory`, or `os.tmpdir()`
   when none is given.
3. `setModel(session.id, provider, modelID)`.
4. `prompt(session.id, text)` — the system instructions lead the prompt,
   separated by a blank line.
5. Poll `getMessages(session.id)` until the newest completed assistant turn
   with text appears, then join its `type === 'text'` parts. The poll stops at
   `timeoutMs` (default 60 s) with `504` `small-model-timeout`, or when the
   caller's `signal` aborts.
6. `deleteSession(session.id)` in a `finally` — the throwaway session never
   outlives the call, even when the read or the prompt fails.

`prompt` returns as soon as the runtime accepts the turn (events stream after),
which is why the reply is polled rather than read once.

Credentials stay inside the runtime; this server only sends a prompt.

### Input clamp

The prompt is measured against the resolved model's context minus an output
reserve, at ~4 chars/token. A model the catalog does not list gets a
conservative 64k default. `onOverflow` decides what an oversized prompt means:

- `truncate` (default) clips the tail and reports `inputTruncated: true`.
  Correct for callers that degrade gracefully (summaries, commit messages).
- `error` throws a `413` with `code: 'context-too-small'` plus
  `requiredChars`/`availableChars`. Correct for callers whose output would be
  quietly wrong on a clipped input, so they can ask the user for a roomier
  model instead of returning confident nonsense.

`maxOutputTokens` is capped at the model's `limit.output`, and the **same
number** is reserved from the input allowance. A session prompt takes no output
budget of its own, so this number only shapes the reserve — but the two sides
must stay equal or a caller that asks for a large answer overruns the context
and the failure looks like a truncation bug.

### Structured output

The runtime has no structured-output mode, so a request that carries a
`responseSchema` fails with `422` `structured-output-unsupported` before any
session is opened. The module does not emulate a schema in the prompt and does
not pretend a reply matched one.

## Model resolution

Three things are decided here, in order:

1. An explicit `model` on the request (`provider/model`) — `source: 'request'`.
2. OpenChamber's settings override (Settings → Sessions → Small Model): when
   `smallModelUseDefault` is `false`, `smallModelOverride` wins —
   `source: 'settings'`.
3. The small model of the caller's provider (`preferredProviderID`: the
   session's, or the composer's for commit messages, PR descriptions, spoken
   summaries, the diff walkthrough and extensions) —
   `source: 'session-provider-small'` — found by `pickSmallModelInProvider`:
   the newest enabled, active, text-in text-out model of the first family in
   `SMALL_MODEL_FAMILY_PRIORITY` (`gpt-luna`, `gemini-flash-lite`,
   `gemini-flash`, `claude-haiku`, then `gpt-nano`, `gpt-mini`) that the
   provider has. The first four are OpenCode's own list for its session
   titles; the last two are v1's additions so a provider with only utility
   models (Copilot) still gets a cheap one. Families are read from the id
   (`familyOf`: luna / flash-lite / flash / haiku / nano / mini), because OMP's
   catalog reports no model family. A model with no release time sorts in
   catalog order — OMP exposes no release date — so "newest" falls back to
   whatever order the runtime returns. A caller that passes
   `restrictToPreferredProvider` (session titles, the session goal, session
   assist, notes from a selection) and finds none then takes the session's own
   model — `source: 'session-model'`: costlier than a small model elsewhere,
   but never another provider's subscription.

OpenCode's step 4 (`GET /api/model/default`) has no OMP equivalent — the
runtime exposes no default-model lookup — so a caller with no explicit model,
no settings override and no provider resolves to `null`.

There is deliberately no step that takes a small model from whichever other
provider is connected: content goes only to the provider the user works with,
the model they picked, or the default they configured.

## Which providers the pickers may offer

`listAuthenticatedProviders()` answers one question for the Small Model and
Changes Walkthrough pickers: which providers the runtime can call right now. A
provider counts when the runtime lists at least one model for it — OMP's
catalog is already credential-filtered, and it exposes no separate provider
list.

The field is served as `authenticatedProviders` on `GET /api/small-model`. The
name predates this resolution; it now means "callable".

## describeSmallModel

Reports which model would be used without calling it: `providerID`, `modelID`,
`source`, plus `inputCharBudget`, `contextTokens`, `contextKnown`,
`outputTokens`, `outputTokenLimit`, `structuredOutput` and `hasLogin`.

`hasLogin` is `true` for every model the runtime lists, because OMP's catalog
is already credential-filtered. `structuredOutput` is always `null`: the
capability is not knowable before a call, and callers must read `null` as "try
it".

Returns `null` when the runtime is not mounted, or when nothing resolves.

`outputReserveTokens` may be a **function** of `{ contextTokens,
outputTokenLimit }` for callers that want as much answer room as the resolved
model allows — they cannot name a number before knowing which model they got.
The resolved value comes back as `outputTokens`.

## Registration

Mounted lazily from `feature-routes-runtime.js` (same pattern as quota): the
module is imported on first request, not at server startup.

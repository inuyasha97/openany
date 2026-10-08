# OpenChamber server module documentation

> This directory (`lib/openchamber/`) holds the OpenChamber-owned modules that
> used to live in `lib/opencode/`. The OpenCode-specific modules those entries
> described (`auth.js`, `auth-state-runtime.js`, `routes.js`, `lifecycle.js`,
> …) are still in `lib/opencode/` and are scheduled for removal with the rest of
> the OpenCode runtime. Where an entry below names
> `packages/web/server/lib/opencode/<module>`, read
> `packages/web/server/lib/openchamber/<module>` for the modules that moved here.

## Purpose
This module provides OpenChamber's server-side configuration, settings, theme,
tunnel and static-route utilities for the web server runtime.

## Entrypoints and structure
- `packages/web/server/lib/opencode/index.js`: public entrypoint (currently baseline placeholder).
- `packages/web/server/lib/opencode/auth.js`: provider authentication file operations.
- `packages/web/server/lib/opencode/auth-state-runtime.js`: managed OpenCode server auth password/header runtime.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/cli-entry-runtime.js`: CLI entrypoint runtime that detects direct execution, parses CLI options, and starts server bootstrap.
- `packages/web/server/lib/opencode/routes.js`: OpenCode/provider settings and auth-related route registration.
- `packages/web/server/lib/opencode/v1-migration-topup.js`: re-arms OpenCode's own V1 -> V2 session import for V1 sessions changed by 1.x after the last completed import; runs only before a managed spawn. See "v1-migration-topup.js" below.
- `packages/web/server/lib/opencode/lifecycle.js`: OpenCode process lifecycle runtime (startup, restart, readiness, health monitoring). After readiness it warms the last-used directory only (first entry of the `getWarmupDirectories` dep, best-effort) because OpenCode initializes each directory lazily on first request and that cost would otherwise be paid by the user's first interactive session open. It warms no other projects: on OpenCode 2 the first directory-scoped read boots that location's whole MCP fleet.
- `packages/web/server/lib/opencode/provider-env-aliases.js`: mirrors known provider credential env aliases into the managed OpenCode process environment (for example `GEMINI_API_KEY` → `GOOGLE_GENERATIVE_AI_API_KEY`) so OpenCode connection detection and the upstream AI SDK agree on the same key names. Canonical implementation shared by web lifecycle and the VS Code managed spawn path (`packages/vscode/src/provider-env-aliases.ts` re-exports this module).
- `packages/web/server/lib/opencode/env-runtime.js`: OpenCode CLI/binary resolution and shell environment runtime.
- `packages/web/server/lib/opencode/env-config.js`: OpenCode-related environment variable parsing and validation (host/port/hostname).
- `packages/web/server/lib/opencode/hmr-state-runtime.js`: HMR-persistent runtime state initialization, auth-state bootstrap, and HMR sync helpers.
- `packages/web/server/lib/opencode/bootstrap-runtime.js`: base app bootstrap runtime for status/auth/tts/notification/OpenChamber route wiring.
- `packages/web/server/lib/opencode/network-runtime.js`: OpenCode URL construction, health-probe readiness checks, and API prefix runtime.
- `packages/web/server/lib/opencode/project-directory-runtime.js`: request-scoped and settings-backed project directory resolution/validation runtime.
- `packages/web/server/lib/openchamber/config-entity-routes.js`: registers the OMP-backed agent/command/MCP/AGENTS.md routes. Writes land as markdown/`mcp.json` files the runtime reads itself, so the route answers plain success.
- `packages/web/server/lib/openchamber/config-mutation-response.js`: shared response builder for applied config mutations.
- `packages/web/server/lib/openchamber/omp-settings-routes.js`: registers `GET|PUT /api/config/cache-retention`, the OMP-native knob that replaced the session-warming row; writes only `providers.cacheRetention` into the agent dir's `config.yml`.
- `packages/web/server/lib/openchamber/snippets.js`: snippet file CRUD, discovery, and hashtag expansion over `~/.omp/agent/snippets` + `<project>/.omp/snippets` (legacy `~/.config/opencode` trees still read). Routes in `config-snippet-routes.js`.
- `packages/web/server/lib/opencode/cli-options.js`: CLI/environment option parsing for server startup arguments.
- `packages/web/server/lib/opencode/core-routes.js`: server status/system routes, auth/access guard routes, and settings utility route registration.
- `packages/web/server/lib/opencode/shutdown-runtime.js`: graceful shutdown orchestration runtime for watcher/session/guest-services/terminal/process/server teardown.
- `packages/web/server/lib/opencode/npm-registry-config.js`: resolves npm package metadata requests from inherited npm registry settings or the user's `.npmrc`, including scoped registries and matching bearer/basic HTTP authentication.
- `packages/web/server/lib/opencode/server-startup-runtime.js`: server listen/startup tunnel flow and process/signal handler orchestration runtime.
- `packages/web/server/lib/opencode/static-routes-runtime.js`: static asset/SPA fallback route registration and manifest route wiring.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: feature route composition runtime for dynamic import-backed config/skill/provider route registration.
- `packages/web/server/lib/opencode/opencode-resolution-runtime.js`: OpenCode binary resolution snapshot runtime for settings routes and diagnostics.
- `packages/web/server/lib/opencode/upgrade-capability.js`: authoritative upgrade ownership policy for the active OpenCode runtime. Bundled, external, and unresolved runtimes fail closed; only managed non-bundled runtimes delegate upgrades to OpenCode.
- `packages/web/server/lib/opencode/tunnel-wiring-runtime.js`: tunnel service/routes composition runtime and active-port wiring for main server startup.
- `packages/web/server/lib/opencode/startup-pipeline-runtime.js`: server startup tail orchestration runtime for terminal/proxy/static/start-listen flow.
- `packages/web/server/lib/opencode/startup-performance.js`: opt-in startup phase diagnostics with fixed labels and numeric metadata allowlists.
- `packages/web/server/lib/agent-tool/runtime.js`: managed OpenCode custom-tool materialization, environment injection, same-machine authentication (loopback, or the bound address for a concrete bind), and fixed CLI action dispatch.
- `packages/web/server/lib/opencode/managed-plugin-config.js`: the `OPENCODE_CONFIG_CONTENT` merge used only on the fallback path, when the user's own environment owns `OPENCODE_CONFIG`.
- `packages/web/server/lib/opencode/managed-config-file.js`: the managed OpenCode config layer — materializes the enabled OpenChamber plugins (agent tools, system prompt optimizer) and publishes them in a file OpenCode watches.

### Managed plugins on OpenCode 2.x
A configured plugin must be a DIRECTORY holding a `package.json` that resolves an
entrypoint; a path to a `.js` file is skipped with "configured plugin path must
be a directory". The config key is `plugins` (an array of absolute directory
paths), not `plugin`.

The generated entrypoint has no imports. OpenCode loads it with a plain dynamic
`import()`, and resolution happens from the plugin's own directory, where nothing
is installed — `import { Plugin } from "@opencode/plugin"` fails there. None of
it is needed: a plugin only has to default-export `{ id, setup }`, and a tool's
`input` accepts plain JSON Schema.

Two v1 affordances are gone and the generated tools work around them: a tool
result has no `title` (it travels in `metadata`) and must not carry `output`
unless an output schema is declared; and a tool call no longer receives
`context.directory` or `context.abort`, so the callback sends `context.sessionID`
and OpenChamber resolves the directory itself.
- `packages/web/server/lib/opencode/server-utils-runtime.js`: shared server runtime utilities for OpenCode proxy wiring, OpenCode port/readiness helpers, and snapshot fetchers.
- `packages/web/server/lib/opencode/openchamber-routes.js`: OpenChamber update and models metadata route registration.
- `packages/web/server/lib/opencode/pwa-manifest-routes.js`: PWA manifest route registration with recent-session shortcut resolution and short-lived caching.
- `packages/web/server/lib/opencode/project-icon-routes.js`: project icon upload/read/discovery route registration and icon storage orchestration.
- `packages/web/server/lib/opencode/skill-routes.js`: route registration for skill config CRUD, supporting files, and skills catalog scan/install flows.
- `packages/web/server/lib/opencode/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization).
- `packages/web/server/lib/opencode/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep.
- `packages/web/server/lib/opencode/settings-normalization-runtime.js`: path/settings/tunnel normalization and sanitization helpers runtime used by settings/routes/config wiring.
- `packages/web/server/lib/opencode/theme-runtime.js`: custom theme JSON validation and theme directory loading runtime for settings utility routes.

  `POST /api/config/themes` saves a converted VS Code palette. The runtime validates
  literal colors and required authored roles, assigns a content-derived filename,
  and publishes through a same-directory hard link so partial files and overwrites
  are impossible. Identical retries reuse the existing file; a manually edited
  collision returns 409. Temporary files are ignored by the loader and removed
  after publication or failure. Non-missing-directory read failures propagate to
  the route instead of returning an authoritative empty library.

  The common request middleware parses theme POST bodies before these routes;
  integration tests must use that middleware rather than an unrestricted test parser.
  `DELETE /api/config/themes/:id` finds a valid regular JSON file by its metadata ID
  inside the custom themes directory. IDs are never used as filenames. Hand-added
  themes are supported; symlinks and bundled themes are outside deletion ownership.
  Duplicate matching IDs fail explicitly. Missing themes are an idempotent success;
  filesystem failures remain errors.
  `theme-catalog.js` owns POST catalog search/package routes under
  `/api/config/themes/catalog/`. It fetches only Open VSX and its Eclipse CDN over
  HTTPS, validates redirects and checksums, and verifies packaged identity.
  `theme-archive.js` reads selected JSON entries in memory with bounded decompression.
  JSON includes and token references stay inside the package. Each failed variant
  is reported separately so valid siblings remain available. No extension code runs.
- `packages/web/server/lib/opencode/proxy.js`: OpenCode API/SSE forwarding and readiness-gate route registration.
- `packages/web/server/lib/opencode/session-runtime.js`: session status/attention/activity runtime for OpenCode SSE events.
- `packages/web/server/lib/opencode/watcher.js`: global SSE watcher runtime for push/session event fanout.
- `packages/web/server/lib/opencode/shared.js`: shared utilities for config, markdown, skills, and git helpers.
- `packages/web/server/lib/openchamber/agent-config-files.js`: the OMP file layer (agent/command/skill paths, markdown parse/write, config layers). The OpenCode 2 shape layer (`config-v2.js`) is gone with the OpenCode server; the agent/command projections the UI still speaks live in `config-entity-routes.js`. See "Config entity routes on OMP (config-entity-routes.js)" below.
- `packages/web/server/lib/ui-auth/ui-auth.js`: UI session authentication runtime (outside OpenCode module).
- `packages/web/server/lib/ui-auth/ui-passkeys.js`: UI passkey storage and WebAuthn registration/authentication helpers (outside OpenCode module).

## Public exports (auth.js)
`auth.js` is read-only. OpenCode 2.x imports `auth.json` once into its own
database and never writes the file again; credentials live behind
`/api/integration` and `/api/credential`, and no HTTP route hands a key back.
OpenChamber needs the raw credential for provider quota lookups, voice keys and
the GitHub and Linear helpers, so `readAuthFile()` answers from the database
OpenCode actually uses (`credential-db.js`, below). A successful database read
is authoritative, `{}` included: OpenCode never clears `auth.json` after the
import and a credential removed in OpenCode vanishes only from the database,
so the file is never merged over a readable database. The legacy file is the
fallback only when the database cannot be read (no sqlite runtime, no file,
unknown schema); a corrupt file then throws, but never blocks a healthy
database. A write here would be invisible to the running OpenCode, so every
write path is gone.

- `readAuthFile()`: The credentials OpenCode uses, keyed by provider id, in the
  legacy `auth.json` entry shape (`{ type: 'api', key }` /
  `{ type: 'oauth', access, refresh, expires, accountId?, enterpriseUrl? }`).
- `getProviderAuth(providerId)`: Returns auth for a specific provider or null.
- `listProviderAuths()`: Returns list of provider IDs with configured auth.
- `AUTH_FILE`: Legacy auth file path constant.
- `OPENCODE_DATA_DIR`: OpenCode data directory path constant.

### credential-db.js

Reads `<data>/opencode.db` (or `OPENCODE_DB`), table `credential`, where
OpenCode 2.x stores every credential as plain JSON. This is OpenCode's private
schema, verified against v2.0.x `packages/core/src/credential/sql.ts`; the
reader opens the file read-only, picks the `active` row per integration (else
the newest), projects `{ type: 'key' }` / `{ type: 'oauth' }` values into the
legacy entry shape, and answers `null` for anything it cannot do (no sqlite
runtime, no file, a changed schema), so the caller can tell "no credentials"
from "could not look" and fall back to the file. `node:sqlite` on Node 22.13+,
`bun:sqlite` on Bun; no dependency is added. `packages/vscode/src/opencodeAuth.ts`
is the extension-host mirror.

### v1-migration-topup.js

OpenCode 2.x imports the legacy `session`/`message`/`part` tables into
`session_v2`/`session_message` once and then records `{"phase":"completed"}`
under `migration.v1-v2` in the `kv` table. Anyone who kept using a bundled
OpenCode 1.x beside a v2 install created V1 sessions after that point, and
OpenCode never looks at them again — they are simply missing from the session
list. `topUpV1Migration()` hands OpenCode a resume cursor so its own migration
picks them up. OpenChamber never writes session rows itself.

It runs from `lifecycle.js` immediately before the MANAGED OpenCode is spawned:
never for an external, user-started OpenCode, and never while a managed one is
running, because the write would race OpenCode's own loop. Failure is never
fatal to startup. It opens `<data>/opencode.db` (or `OPENCODE_DB`) read-write
with the same loader strategy as `credential-db.js` — `node:sqlite` on Node,
`bun:sqlite` on Bun, skip silently on neither. It returns
`{ status: 'skipped' | 'scheduled' | 'unsafe' | 'unavailable', missing, revisited, reason? }`
and logs one line; there is no HTTP route and no UI.

What it does: when the migration row says `completed` and some `session` rows
have no `session_v2` twin AND were changed by 1.x after the last completed
import (`session.time_updated` past the row's `time_updated`, which OpenCode
stamps on completion), it sets the row to `{"phase":"sessions","cursor":…}`.
The time test matters because a v2 delete leaves the legacy row behind
(`Session.remove` publishes `session.deleted`, `bus.remove` then wipes that
session's durable events, `session_v2` cascades), and only OpenCode 1.x writes
the legacy table: when nobody ran 1.x since the last import, nothing qualifies
and the top-up skips, so sessions deleted in v2 stay deleted.
The cursor is the largest missing id plus `U+FFFF`, because OpenCode's loop
walks `id < cursor` in descending id order and ids are fixed width, so nothing
real can fall between an id and that cursor. Ids are compared the way SQLite
does (BINARY/memcmp; neither id column declares a collation). Session ids
encode time descending in a field that wraps, so id order is **not** time
order — an August session can sort far below a newer one, and the code never
assumes otherwise.

Hard rules, verified against v2.0.8 (the completion stamp against v2.0.16)
`packages/core/src/database/v1-migration.bun.ts`:

- **Never clear or delete the `migration.v1-v2` row.** With no row at all
  OpenCode treats the database as pre-migration and DELETEs the whole `event`
  table, v2's durable event log.
- **Never make OpenCode revisit a session that has v2 activity.** Every session
  the loop visits gets its `session_message` rows deleted and replaced by the
  V1 transform. Before writing a cursor, the top-up lists the already-migrated
  sessions below it and looks for a message created after the migration
  completed, a `session_v2.time_updated` after it, or a message `type` the V1
  transform never emits (it only produces `user`, `assistant`, `synthetic`,
  `compaction`). Any hit and nothing is written: the outcome is `unsafe`
  (`revisited-sessions-have-v2-activity`) and a single warning names how many
  sessions stay missing.
- **Only 1.x activity triggers an import** (maintainer, 2026-09-24). When 1.x
  was used again, OpenCode's loop still walks every legacy row under the
  cursor, so a deleted session sorting below a fresh one comes back with it;
  avoiding that needs an upstream import route that takes explicit ids.

## Public exports (credentials.js)

`credentials.js` is the OMP-side replacement for `auth.js`: the quota providers,
the voice keys and the routing classifier read the credentials OMP itself uses,
and `lib/opencode/auth.js` now serves only the OpenCode feature routes that have
not been ported yet. It is read-only, and it reads three stores in order:

- `<agent dir>/agent.db`, table `auth_credentials` — the credentials `/login`
  and the API-key form write (`credential_type` is `api_key` or `oauth`, `data`
  is their JSON). The read mirrors OMP's own active-credential query
  (`disabled_cause IS NULL`), so a deleted credential stays a tombstone and its
  key never comes back. The most recently updated row of a provider wins, because
  the map has one slot per provider while OMP may hold several accounts.
- `<agent dir>/models.yml`, `providers.<id>.apiKey`, through the same reader the
  rest of the OMP file layer uses. A `!command` value is skipped: running it
  needs OMP's shell semantics, and the command string must never reach a
  provider as its key.
- the environment, per provider, using the variable OMP's own catalog declares
  (`PROVIDER_ENV_VARS`, e.g. `OPENCODE_API_KEY`, `ANTHROPIC_API_KEY`). Consulted
  only for a provider with no stored credential, so a tombstoned credential
  stays deleted.

The agent directory is OMP's: `PI_CODING_AGENT_DIR`, then a named profile
(`OMP_PROFILE`/`PI_PROFILE`), then `~/.omp/agent`. `resolveCredentialDbPath`
additionally follows `omp config init-xdg` to `$XDG_DATA_HOME/omp/agent.db` for
the default agent directory, the way `getAgentDbPath()` does. OMP keeps no
credential in `config.yml` (its settings have no `apiKey` field), `secrets.yml`
is a redaction list rather than a store, and under `OMP_AUTH_BROKER_URL` the
credentials live on the broker while the local store is empty. OMP also loads
`.env` files (`<cwd>/.env`, `<agent dir>/.env`, `~/.omp/.env`, `~/.env`) that
this reader does not parse, so only the process environment is visible.

Entries are the legacy `auth.json` shape (`{ type: 'api', key }` /
`{ type: 'oauth', access, refresh, expires, accountId?, … }`), with `expires` in
OMP's epoch milliseconds — every consumer normalizes a seconds/ms value itself.
OMP renamed several providers, so `LEGACY_PROVIDER_KEYS` republishes a renamed
credential under the key the consumers' alias lists search for (`opencode-zen` →
`opencode`, `openai-codex` → `openai`, `kimi-code` → `kimi-for-coding`,
`wafer-serverless` → `wafer`, `zhipu-coding-plan` → `zhipuai-coding-plan`,
`charm-hyper` → `hyper`, `xai-oauth` → `xai`, `minimax-code`/`minimax-code-cn` →
`minimax-coding-plan`/`minimax-cn-coding-plan`, `google-gemini-cli` →
`google.oauth`, `vercel-ai-gateway` → `vercel`); a provider that really exists
under the old key keeps its own entry, and every pairing was verified against
OMP's catalog in `pi-catalog/src/compat/rules`.

- `readAuthFile(options?)`: The credentials OMP uses, keyed by provider id. A
  database that cannot be read (no sqlite runtime, no file, unknown schema) still
  leaves models.yml and the environment; a models.yml that does not parse throws
  only when the database could not answer either, and never blocks a healthy one.
- `getProviderAuth(providerId)`: Returns auth for a specific provider or null.
- `listProviderAuths()`: Returns list of provider IDs with configured auth.
- `resolveCredentialDbPath(...)`, `projectCredential(...)`,
  `readCredentialsFromDb(...)`, `readApiKeysFromModelsConfig(...)`,
  `PROVIDER_ENV_VARS`, `LEGACY_PROVIDER_KEYS`: the pieces above, exported for
  focused tests.

## Public exports (providers.js)
- `getProviderSources(providerId, workingDirectory)`: Resolves which OpenCode config layers define a provider.
- `listProviderConfigs(workingDirectory)`: Every provider a config layer defines, projected into the canonical v2 `ProviderEntity` shape, with `legacy` marking entries still stored under the v1 `provider` key.
- `upsertProviderConfig(providerId, config, workingDirectory, scope?, options?)`: Validates and writes a custom provider block into the user/project/custom config layer. The payload may use the v2 spelling (`package`, `settings.baseURL`, `headers`) or the v1 spelling (`npm`, `options.baseURL`); what lands on disk is always a v2 `providers` entry with `package: "aisdk:<npm>"` and `settings.baseURL`. The adapter may be OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages. Existing provider, option, and retained-model fields not managed by the form are preserved; omitted models, headers, and env credentials remain explicit removals. A model's `variants` (reasoning levels) are replaced when the payload carries the array, cleared when it carries an empty one, and kept when the key is absent. Updating an entry still stored under the legacy `provider` key rewrites it under `providers` in the same file, dropping the fields v2 accepts but ignores; unrelated legacy siblings are untouched. Does not store API keys. Requires `config.env` or `options.hasStoredAuth`. OpenCode 2 keeps credentials in its own store, so `PUT /api/provider` sets `hasStoredAuth` from the request's `hasCredential` (the form is about to store a key, or the edited provider keeps its credential) as well as a legacy `auth.json` entry. The key itself goes through `integration.connect.key` after this write, because OpenCode registers a custom provider's key method only once the provider is in config. Edit flows must pass the provider's effective existing layer (`custom` > `project` > `user`) so updates do not create a global user override.
- `validateCustomProviderConfig(providerId, config, options?)`: Structural validation for custom provider payloads (id format, adapter allowlist `@ai-sdk/openai-compatible`/`@ai-sdk/openai`/`@ai-sdk/anthropic`, http(s) base URL, models, credentials via `env` or `hasStoredAuth`). Accepts both spellings and returns the normalized v2 value.
- `removeProviderConfig(providerId, workingDirectory, scope?)`: Removes a provider block from the selected config layer.

## Public exports (shared.js)
- `OPENCODE_CONFIG_DIR`, `AGENT_DIR`, `COMMAND_DIR`, `SKILL_DIR`, `CONFIG_FILE`: Path constants rooted at `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is non-empty, otherwise `~/.config/opencode`. These constants are evaluated when the module loads; no files are migrated. `OPENCODE_CONFIG` remains a separate explicit config-file path and is resolved at call time for the custom config layer; it does not replace the global config directory.
- `AGENT_SCOPE`, `COMMAND_SCOPE`, `SKILL_SCOPE`: Scope constants with USER and PROJECT values.
- `ensureDirs()`: Creates required OpenCode directories.
- `parseMdFile(filePath)`, `writeMdFile(filePath, frontmatter, body)`: Markdown file operations with YAML frontmatter.
- `getConfigPaths(workingDirectory)`, `readConfigLayers(workingDirectory)`, `readConfig(workingDirectory)`: Config file operations with layer merging (user, project, custom). `readConfigLayers` isolates `INVALID_JSONC` per layer: a broken file is omitted from the merge (`{}` for that layer only), recorded on `layerErrors`, and does not block valid sibling layers. Writes still refuse to overwrite the broken file.
- `readConfigFile(filePath)`: Reads one config file. Missing, whitespace-only, and comment-only files return `{}`; a comment-only file is recognized by `ValueExpected` being the only parse error. A `jsonc-parser` error that produces a partial or non-object tree throws `INVALID_JSONC` — partial parse trees must never be treated as authoritative (avoids rewriting a `$schema`-only stub over a full config). Content that yields no JSON value for any other reason (YAML, plain text) also throws instead of reading as empty.
- `readConfigLayer(filePath)`: Same parse as `readConfigFile`, but isolates `INVALID_JSONC` to `{ config: {}, error }` so plugin/MCP/agent readers can skip one broken layer without aborting valid siblings. Writes still refuse to overwrite the broken file.
- `writeConfig(config, filePath)`: Writes config with automatic backup. Refuses to overwrite an existing non-empty file that fails the same JSONC parse check.
- `getJsonEntrySource(layers, sectionKind, entryName)`: Resolves which config layer provides an entry. `sectionKind` is `agents`, `commands`, `providers`, or `mcp`, and both the v2 and the v1 spelling are searched (v2 wins). The result carries `sectionKey` (the spelling that actually held the entry) and `legacy`, so a writer can rewrite the same file in v2 shape. A failed custom or user layer throws `INVALID_JSONC` instead of treating that file as empty. A failed project layer is skipped so a valid user/custom entry can still be found.
- `getJsonWriteTarget(layers, preferredScope)`: Determines write target for config updates. Throws `INVALID_JSONC` when the chosen target file is the unparseable layer.
- `getAncestors(startDir, stopDir)`, `findWorktreeRoot(startDir)`: Git worktree helpers.
- `isPromptFileReference(value)`, `resolvePromptFilePath(reference)`, `writePromptFile(filePath, content)`: Prompt file reference handling.
- `walkSkillMdFiles(rootDir)`: Recursively finds all SKILL.md files.
- `addSkillFromMdFile(skillsMap, skillMdPath, scope, source)`: Parses and indexes a skill file.
- `resolveSkillSearchDirectories(workingDirectory)`: Returns skill search path order (config, project, home, custom).
- `listSkillSupportingFiles(skillDir)`, `readSkillSupportingFile(skillDir, relativePath)`, `writeSkillSupportingFile(skillDir, relativePath, content)`, `deleteSkillSupportingFile(skillDir, relativePath)`: Skill supporting file management.

## Public exports (routes.js)
- `registerOpenCodeRoutes(app, dependencies)`: Registers OpenCode-owned HTTP routes and internal module runtime:
  - `GET /api/config/settings`
  - `PUT /api/config/settings`
  - `GET /api/config/opencode-resolution`
  - `POST /api/opencode/upgrade` (enforces the active runtime's upgrade capability, shares concurrent upgrade requests and runs the resolved CLI with `upgrade`; the existing Reload action restarts managed OpenCode afterwards)
  - `GET /api/opencode/upgrade-status` (returns version availability plus the authoritative `upgrade.supported`, `upgrade.manager`, and `upgrade.reason` capability)
  - `POST /api/opencode/directory` (validates and activates an existing project directory; `{ create: true }` explicitly creates the requested project directory before activation, including outside the previously active workspace)
  - `GET /api/provider/:providerId/source`
  - `PUT /api/provider` (create/update custom OpenAI-compatible provider config in OpenCode user/project/custom layers via `scope`; secrets stay in auth via the OpenCode auth API)
  - `DELETE /api/provider/:providerId/auth`
  - Enterprise mode (`../enterprise-mode.js`): `PUT /api/provider` and the OpenCode writes that would otherwise pass the generic proxy — every `POST` under `/api/integration/:id/connect` (key, OAuth start and complete, command) and `POST /api/experimental/integration/wellknown`, matched by `isProviderConnectRequest` — answer 403 `enterprise_mode`. The VS Code extension host refuses the same requests with the same matcher. Removing, activating or renaming an existing credential still reaches OpenCode. This closes the way in through the app; OpenCode's `provider.use` policy is the real lock.
- Owns lazy auth library loading for provider auth checks/removal.
- Keeps route behavior independent from composition root; `index.js` now supplies dependencies only.

## CLI upgrades

`cli-upgrade.js` runs the host-resolved executable and wrapper arguments with
`upgrade`, without a shell or client-supplied arguments. OpenCode chooses the
installer. Web, hosted mobile, Capacitor, and Desktop with a separately installed
CLI use this server path. VS Code uses the same executor from its extension host.
Bundled Desktop, external URL connections, and unavailable CLIs remain
unsupported at the host boundary.

An upgrade leaves the current server running. The toast's Reload action restarts
it using the installed version. Failed installations return an error and can be
retried; installer output is not returned or logged because it can contain registry
credentials. Requests from multiple clients share the in-flight operation. The
executor supplies EOF and bounds captured output; installation has no fixed time
limit, and the VS Code bridge does not apply its usual 30-second request timeout.

### Migrating an installed v1 CLI

`GET /api/opencode/compatibility` reads the local CLI version without starting
its server, or probes an external server's JSON version contract (`/api/info`,
then v1's `/global/health` even when the first probe fails or hangs). When
`OPENCODE_HOST`/`OPENCODE_PORT` points at a server that identifies as v1 or a
2.x below the minimum, startup attaches to it as external and not ready rather
than spawning a managed instance, so this check reports its version. A confirmed
managed v1 CLI on macOS, Linux or Windows (x64/arm64) advertises `canInstall`;
bundled binaries and external connections do not.

`POST /api/opencode/install-v2` rechecks that capability and shares one operation
across concurrent clients. `v2-install.js` resolves a validated stable v2
release from npm. On macOS/Linux it downloads the official
`https://opencode.ai/v2/install` script and runs it with that release and
`--no-modify-path`. That script is bash, so on Windows it downloads the npm
platform package the script would fetch (`@opencode/cli-windows-arm64` on
arm64, `@opencode/cli-windows-x64-baseline` on x64, like the desktop bundle), checks it against the `sha512` integrity
npm publishes, and unpacks `opencode.exe` with the system `tar.exe`. Both
paths then verify the resulting executable.
It installs into the host user's standard `~/.opencode/bin`. Existing npm/Bun
packages remain installed; the host selects the new binary through
`opencodeBinary`, restarts OpenCode, and waits for v2 readiness before replying.

A filesystem lock prevents separate hosts sharing a home from installing at
the same time. The installer has a five-minute deadline and owns its subprocess
group. Existing executable/shim files are restored after an installation or
verification failure. If rollback fails, backups and the lock remain under
`.opencode/bin/.openchamber-install` for manual recovery. A successful install
followed by a settings/restart failure keeps v2 on disk; Check again can retry
the restart. A host crash may also leave the lock for manual recovery.
Installer output is discarded, not forwarded to clients or logs.

## Public exports (omp-unsupported.js)
- `unsupportedOnOmp(what)`: the error a feature throws for a surface OpenCode had and OMP has no counterpart of (a synthetic message, a command dispatch, a session agent, a model variant, prompt attachments). `name: OmpUnsupportedError`, `code: OMP_UNSUPPORTED`, `status: 501`. Thrown rather than dropped or substituted, so the caller fails visibly instead of silently losing the input.

## Public exports (session-activity.js)
- `createSessionActivityProbe()`: whether a session's turn really ended. OpenCode answered `/api/session/active` and `GET /api/session?parentID=`; OMP answers one session's busy flag (`getSessionStatus`) and lists no child sessions, so a subagent runs inside its parent's turn. `fetchActiveSessionStatuses()` builds the busy map from `listSessions()` + `getSessionStatus(id)`, `fetchChildSessionIds(id)` answers `[]` once the runtime has answered, `hasWorkingChildren(id, statuses)` answers `false`. Every read answers `null` when the runtime could not be asked. Used by the goal loop, the queued-message dispatch and the notification runtime.

## Public exports (session-runtime.js)
- `createSessionRuntime({ writeSseEvent, getNotificationClients, broadcastEvent? })`: creates runtime-owned state machine and APIs for session status.
- Returned API:
  - `processOpenCodeSsePayload(payload)`
  - `getSessionActivitySnapshot()`
  - `getActiveSessionCount()`
  - `getSessionStateSnapshot()`
  - `getSessionAttentionSnapshot()`
  - `getSessionState(sessionId)`
  - `getSessionAttentionState(sessionId)`
  - `markSessionViewed(sessionId, clientId)`
  - `markSessionUnviewed(sessionId, clientId)`
  - `markUserMessageSent(sessionId)`
  - `resetAllSessionActivityToIdle()`
  - `interruptBusySessionsAfterRestart()`: settles every session whose authoritative status is `busy`/`retry` or whose activity phase is still busy, broadcasts `openchamber:session-status` idle plus an OpenCode-shaped `session.error`, resets leftover activity/cooldowns, and returns the interrupted session IDs in stable order.
  - `dispose()`

The runtime maintains active-session count incrementally from idempotent activity phase transitions. Upstream stall-timeout and lifecycle health checks read it in O(1); the hourly cleanup removes activity phases older than 24 hours without broadcasting synthetic state transitions. Snapshot generation remains reserved for the session-activity API.

## Public exports (lifecycle.js)
- `createOpenCodeLifecycleRuntime(dependencies)`: creates lifecycle runtime for managed/external OpenCode process orchestration. The optional `onOpenCodeRestarted` dependency (default `null`) is fired after a successful managed restart. `index.js` rebinds event-stream readers to the possibly-new port (#2638), then calls `interruptBusySessionsAfterRestart()` and broadcasts one `opencode-restart-interrupted` UI notification when interrupted turns exist (#2943).
- Returned API:
  - `startOpenCode()`
  - `restartOpenCode()`
  - `waitForOpenCodeReady(timeoutMs?, intervalMs?)`
  - `waitForAgentPresence(agentName, timeoutMs?, intervalMs?)`
  - `refreshOpenCodeAfterConfigChange(reason, options?)`
  - `bootstrapOpenCodeAtStartup()`
  - `startHealthMonitoring(healthCheckIntervalMs)`
  - `waitForPortRelease(port, timeoutMs, hostname?)`
  - `killProcessOnPort(port)`

Managed OpenCode launch also merges the environment returned by the agent-tool
runtime and the opt-in system prompt optimizer, each appending its `file://`
entry to the previous one's config. OpenChamber adds no automatic MCP reconnect
loop; recovery after a failed connection is manual for both local and remote
servers. Previously generated reconnect plugin files are inert because managed
launch no longer registers them. User-configured plugins remain user-owned.
PATH, `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD` remain lifecycle-owned
and cannot be replaced by injected or inherited values; OpenCode 2 prefers
`OPENCODE_PASSWORD`, so both carry the managed password. A user-provided
password is read with the same precedence, and Basic auth always uses the
`opencode` username because OpenCode 2 accepts no other. External OpenCode processes receive no
OpenChamber tool injection. Managed launch env strips AppImage `ARGV0` before
spawn so zsh-backed OpenCode tools do not rewrite child argv[0] to the AppImage
path (#2588).

Before spawn, `applyProviderEnvAliases` fills unset Google credential aliases
from any present sibling (`GOOGLE_GENERATIVE_AI_API_KEY`, `GOOGLE_API_KEY`,
`GEMINI_API_KEY`) so a shell that only exports `GEMINI_API_KEY` still satisfies
the Generative AI SDK path used at chat time. Existing non-empty values are
never overwritten.

Set `OPENCHAMBER_STARTUP_PERF=1` to emit bounded startup phase records for server listen, managed OpenCode preparation/readiness, and proxy readiness holds. Every OpenCode bootstrap emits one terminal `opencode.bootstrap.ready` or `opencode.bootstrap.error` event, including reused and external server paths. Records contain controlled phase/outcome/route labels and timing values only; they never contain request URLs, runtime keys, directories, session IDs, credentials, or content.

macOS `say` voice enumeration starts concurrently with server composition. The server listener and managed OpenCode startup do not wait for it; `/api/tts/say/status` awaits the same authoritative capability promise when queried before enumeration completes.

Upstream health is probed with `GET /api/info` (OpenCode 2.0.8 removed `/api/health`). A 200 is the whole readiness answer — the payload is `{ version, pid, urls, paths }` and carries no `healthy` field — and its `version` is what the major-version gate reads. OpenChamber's own `/api/opencode/health` keeps answering `{ healthy }` to its clients, derived from that status.

Transport-triggered health checks share the periodic monitor's failure accounting interval. Rapid WS reconnect callbacks therefore cannot exhaust the managed-process restart threshold using one cached unhealthy result; an exited managed process still restarts immediately.

Managed health failures are classified as `timeout`, `connection_refused`, `connection_reset`, `invalid_response`, or `error`. The lifecycle retains the latest counted failure with a bounded detail string and source. Managed process wrappers continue capturing a sanitized, bounded stderr tail after readiness and retain exit code/signal. Before replacing a managed process, lifecycle snapshots the reason, latest health failure, process diagnostics/aliveness, busy-session count, and timestamp into `lastOpenCodeRestartDiagnostics`; successful startup does not clear this snapshot, and `/health` exposes it for post-restart diagnosis without process environment or credentials.

Managed process ownership starts at spawn. The registry and runtime process
handle include children that have not announced readiness yet, so shutdown can
stop an in-flight startup. Readiness timeout, malformed startup output, and
health-probe errors close that child before retrying. Shutdown cancels further
startup attempts. Closing a process is single-flight and unregisters it only
after it exits.

On Windows, managed teardown invokes the existing tree termination command
before terminating the root. Calling `child.kill()` first loses the ancestry
needed to find Git, shell, and MCP descendants. On POSIX, the managed child
starts in its own process group and teardown escalates against that group even
if the root has already exited. A tool ignoring SIGTERM must not survive just
because the server closed its own pipes. The
`lifecycle-process.test.js` regressions launch real parent/child fixtures and
check PID exit plus registry cleanup. macOS results do not validate Windows
ConPTY or Console Window Host behavior.

## Public exports (env-runtime.js)
- `createOpenCodeEnvRuntime(dependencies)`: creates runtime that owns OpenCode CLI environment and binary discovery state.
- OpenCode CLI resolution order is persisted settings, environment overrides, bundled Desktop CLI when available, PATH, known install locations, then platform shell discovery.
- Automatic bundled resolution under `OPENCHAMBER_RUNTIME=desktop` stays in runtime state and is returned to the managed launch function, including on OpenCode restart. It does not populate `process.env.OPENCODE_BINARY`: AppImage updater relaunch inherits that environment and would mistake the previous bundle path for an explicit override. Explicit settings/env selections and non-desktop or non-bundled resolution retain their existing environment behavior. This prevents future inheritance; it does not reinterpret overrides already inherited from older releases.
- The login-shell snapshot (`$SHELL -lic 'echo __OPENCHAMBER_ENV__; env -0'`, parsed from after the last marker line so text an rc file prints to stdout never fuses with the first variable) is taken synchronously at import time, so it blocks whatever process embeds the server for as long as the user's shell startup files take. An embedding host that already probed the shell hands its result over before importing the server through `login-shell-env.js` (`provideLoginShellEnvSnapshot(snapshot | null)`); the runtime then uses that and never probes, `null` included. Desktop does this on macOS and Linux; on Windows the server keeps its own registry-based snapshot. The handoff is a module slot, never an environment variable: the snapshot is the user's whole shell environment and `process.env` reaches every child.
- Returned API:
  - `applyLoginShellEnvSnapshot()`
  - `getLoginShellEnvSnapshot()`
  - `ensureOpencodeCliEnv()`
  - `applyOpencodeBinaryFromSettings()`
  - `resolveOpencodeCliPath()`
  - `resolveManagedOpenCodeLaunchSpec(opencodePath)`: resolves the effective managed OpenCode launch target, unwrapping Windows package-manager shims to a direct native binary or explicit runtime+script when possible.
  - `resolveGitBinaryForSpawn()`
  - `resolveWslExecutablePath()`
  - `buildWslExecArgs(execArgs, distroOverride?)`
  - `isExecutable(filePath)`
  - `searchPathFor(binaryName, searchPath?)`: resolves an executable from the supplied PATH value, defaulting to the process PATH.
  - `clearResolvedOpenCodeBinary()`

## Public exports (env-config.js)
- `resolveOpenCodeEnvConfig(options?)`: resolves and validates OpenCode host/port/hostname environment configuration.
- Returned object fields:
  - `configuredOpenCodePort`
  - `configuredOpenCodeHost`
  - `effectivePort`
  - `configuredOpenCodeHostname`

## Public exports (hmr-state-runtime.js)
- `createHmrStateRuntime(dependencies)`: creates runtime for HMR state container initialization and runtime<->HMR state synchronization.
- Returned API:
  - `getOrCreateHmrState()`
  - `ensureUserProvidedOpenCodePassword(hmrState)`
  - `getUserProvidedOpenCodePassword(hmrState)`
  - `resolveOpenCodeAuthFromState({ hmrState, userProvidedOpenCodePassword })`
  - `syncStateFromRuntime(hmrState, runtime)`
  - `restoreRuntimeFromState({ hmrState, userProvidedOpenCodePassword })`

## Public exports (bootstrap-runtime.js)
- `createBootstrapRuntime(dependencies)`: creates runtime for base app route bootstrap and UI auth controller initialization.
- Returned API:
  - `setupBaseRoutes(app, options)`

## Public exports (network-runtime.js)
- `createOpenCodeNetworkRuntime(dependencies)`: creates runtime for OpenCode network and URL concerns.
- Returned API:
  - `waitForReady(url, timeoutMs?)`
  - `normalizeApiPrefix(prefix)`
  - `setDetectedOpenCodeApiPrefix()`
  - `buildOpenCodeUrl(path, prefixOverride?)`
  - `ensureOpenCodeApiPrefix()`
  - `scheduleOpenCodeApiDetection()`

## Public exports (settings-runtime.js)
- `createSettingsRuntime(dependencies)`: creates settings lifecycle runtime for read/migrate/persist concerns.
- Returned API:
  - `readSettingsFromDisk()`
  - `readSettingsFromDiskMigrated()`
  - `writeSettingsToDisk(settings)`
  - `persistSettings(changes)`
- Persistent per-session permission modes are stored under `permissionAutoAccept`, and the mode for new sessions under `permissionDefaultMode`; execution ownership lives in `lib/permission-auto-accept/`.
- Queued follow-up messages live in `<data-dir>/message-queue.json`, not in settings; execution ownership lives in `lib/message-queue/`.
- Shared sidebar preferences are stored as validated top-level fields: `sidebarProjectDisplayMode`, `sidebarSessionGroupingMode`, `sidebarProjectSortOrder`, and `sidebarShowRecentSection`. Device-local picker selection and sticky-header state do not enter either settings file.
- Two files (`settings-files.js`): `settings.json` holds instance facts and any legacy or unknown keys; `preferences.json` beside it holds every key the generated registry snapshot (`settings-registry.json`) marks `profile`, as `{ version: 1, fields: { key: { value, updatedAt, surfaces? } } }`. Keys the snapshot marks `perSurface` are stored per surface kind: `GET`/`PUT /api/config/settings` read the client's kind from the `surface` query parameter (`settingsSurfaceOf`; the legacy `x-openchamber-surface` header is still honoured, but a header forces a CORS preflight that cross-origin shells and older instances refuse, so clients must not send one) (`web`, `desktop`, `vscode`, `mobile`; anything else means base), `persistSettings(changes, { surface })` writes a changed per-surface key under `surfaces[surface]` and never touches its base, and `readSettingsFromDisk({ surface })` resolves that kind's value first, the base otherwise. Callers without a surface (migrations, the seed, server-side feature writers) read and write the base. `readSettingsFromDisk()` returns the merged document and seeds `preferences.json` once from an existing `settings.json` (which it leaves intact). An existing `preferences.json` that fails to parse is a failure, not an empty profile: it is never seeded or overwritten, the merged read serves the instance part, and `persistSettings` drops profile keys with a warning until the file is fixed or removed. `writeSettingsToDisk(document)` splits by scope and writes `settings.json` as the instance part plus a copy of the profile's base values (`legacySettingsDocumentOf`): a build from before the split reads only that file, so a rollback keeps the user's preferences, while current builds ignore the copy because `preferences.json` wins in the merge; device keys are dropped from writes. Modules that read one profile key off the disk on a hot path use `readMergedSettingsSync`.

## Public exports (settings-files.js)
- `parsePreferencesDocument(raw)`, `serializePreferencesDocument(fields)`, `flattenPreferences(fields)`, `buildPreferencesFields(previousFields, document, now)`, `instancePartOf(document)`, `seedPreferencesFrom(document, now)`, `readMergedSettingsSync({ fs, path, settingsFilePath })`, `getSettingsScope(key)`, `isProfileSettingsKey(key)`, `isDeviceSettingsKey(key)`, `preferencesFilePathFor(settingsFilePath, path)`.
- The VS Code extension host writes the same two files with the same shape (`packages/vscode/src/settings-files.ts`); format changes go to both.

## Public exports (settings-helpers.js)
- `createSettingsHelpers(dependencies)`: creates settings helper runtime for settings request/response shaping.
- Returned API:
  - `normalizePwaAppName(value, fallback?)`
  - `sanitizeSettingsUpdate(payload)`
  - `mergePersistedSettings(current, changes)`
  - `formatSettingsResponse(settings)`

## Public exports (settings-normalization-runtime.js)
- `createSettingsNormalizationRuntime(dependencies)`: creates normalization/sanitization runtime for shared settings and tunnel helper logic.
- Returned API:
  - `normalizeDirectoryPath(value)`
  - `normalizePathForPersistence(value)`
  - `normalizeSettingsPaths(input)`
  - `normalizeTunnelBootstrapTtlMs(value)`
  - `normalizeTunnelSessionTtlMs(value)`
  - `normalizeManagedRemoteTunnelHostname(value)`
  - `normalizeManagedRemoteTunnelPresets(value)`
  - `normalizeManagedRemoteTunnelPresetTokens(value)`
  - `isUnsafeSkillRelativePath(value)`
  - `sanitizeTypographySizesPartial(input)`
  - `normalizeStringArray(input)`
  - `sanitizeModelRefs(input, limit)`
  - `sanitizeSkillCatalogs(input)`
  - `sanitizeProjects(input)`

## Public exports (theme-runtime.js)
- `createThemeRuntime(dependencies)`: creates custom theme runtime for on-disk theme discovery and JSON normalization/validation.
- Returned API:
  - `normalizeThemeJson(raw)`
  - `readCustomThemesFromDisk()`

## Public exports (project-directory-runtime.js)
- `createProjectDirectoryRuntime(dependencies)`: creates runtime for request/project directory candidate normalization and validation. `dependencies.refuseDirectory(candidate)` answers the reason a resolved directory may not be used on this host, or null; `validateDirectoryPath` asks it before it looks at the disk, so a refused directory is never touched and never falls back to another one. The isolated-spaces host refuses `/spaces/...` through it while its switch is on.
- Returned API:
  - `resolveDirectoryCandidate(value)`
  - `validateDirectoryPath(candidate)`
  - `resolveProjectDirectory(req)`
  - `resolveOptionalProjectDirectory(req)`

## Entity routes (OMP)

Everything OpenChamber persists for agents, commands, MCP servers and the
global behavior prompt lives in OMP's own storage (markdown files and
`mcp.json`), not in an OpenCode config file. The "Config entity routes on OMP
(config-entity-routes.js)" section below is the contract: file paths, entity
projections, per-route JSON and the fields that have no OMP home.

The OpenCode 2 config surface is gone with the OpenCode server: there is no
`opencode.json(c)` agent/command/provider/plugin/MCP section, no v1→v2 section
migration, and no `/api/provider`, `/api/config/plugins`, `/api/config/websearch`
or `/api/config/warming` route. Web search and warming had no OMP storage key at
all; the provider and plugin routes had no production UI caller. What is kept is
the entity *shape* the Settings stores still exchange — only the storage behind
it changed.

### Canonical entity shapes

One shape per entity, shared by the routes that serve it and the stores that
consume it. The markdown projections live in `config-entity-routes.js`
(`toAgentEntity` / `fromAgentEntity`, `toCommandEntity` / `fromCommandEntity`);
they keep the OpenCode 2 spelling the Settings UI exchanged so the existing
stores need no change. Only the storage behind the shape is OMP's.

```jsonc
// PermissionRule — ordered array, last match wins.
// Actions: shell, subagent, edit, read, grep, glob, patch, webfetch, websearch,
// skill, question, external_directory, provider.use, "*"
{ "action": "shell", "resource": "git push *", "effect": "ask" }  // effect: allow | deny | ask

// AgentEntity — frontmatter of agents/<name>.md; `system` is the markdown body.
{
  "system": "Review for correctness.",
  "description": "Reviewer",
  "model": "anthropic/claude-sonnet-4-5#high",
  "mode": "primary",                     // primary | subagent | all
  "hidden": false,
  "color": "#aabbcc",
  "steps": 12,
  "disabled": false,
  "request": { "headers": {}, "body": { "temperature": 0.4, "top_p": 0.9 } },
  "permissions": [ /* PermissionRule */ ]
}

// CommandEntity — frontmatter of commands/<name>.md; `template` is the body.
{
  "template": "Review the current changes.",
  "description": "Review",
  "agent": "reviewer",
  "model": "anthropic/claude-sonnet-4-5#high",
  "subagent": true
}

// McpEntity — projected from an OMP `mcpServers` entry; `type` is `local` or
// `remote`. See the mapping table below for which fields OMP carries.
// `credentialId` (OMP's `auth.credentialId`) and `authenticated` (whether that
// id still resolves in OMP's agent database) are read-only state the server
// computes, never written back to `mcp.json`.
{ "type": "local", "command": ["npx", "@playwright/mcp"], "cwd": "…",
  "environment": {}, "disabled": false, "timeout": { "execution": 30000 } }
{ "type": "remote", "url": "https://mcp.example.com", "headers": {},
  "oauth": { "client_id": "…", "client_secret": "…", "scope": "…",
             "callback_port": 4242, "redirect_uri": "…" },
  "disabled": false }
```

`model` is always the joined string `providerID/modelID#variant`. The
projections split it with `parseModelSelection` and join it back with
`formatModelSelection`.

### Request and response JSON per route

`GET /api/config/agents/:name` — metadata about where the agent is defined.
```jsonc
{
  "name": "reviewer",
  "scope": "project",              // project | user | null
  "isBuiltIn": false,
  "sources": {
    "md":   { "exists": true, "path": "…/.omp/agents/reviewer.md", "scope": "project",
              "legacy": true,      // file uses keys outside the native set
              "fields": ["description", "model", "permissions"] },
    // OMP has no JSON entity sections, so this is a typed marker, never a fake
    // path/scope: the md/projectMd/userMd data stays in place.
    "json": { "exists": false, "unsupported": true,
              "code": "OMP_UNSUPPORTED_CONFIG_SECTION", "error": "…" },
    "projectMd": { "exists": true,  "path": "…" },
    "userMd":    { "exists": false, "path": "…" }
  }
}
```

`GET /api/config/agents/:name/config` — the canonical entity.
```jsonc
{
  "source": "md",                  // md when a markdown file exists; otherwise 501
  "scope": "project",
  "path": "…/.omp/agents/reviewer.md",
  "legacy": true,
  "config": { /* AgentEntity */ }
}
```

`GET /api/config/agents/:name/permissions` — what applies to this agent.
```jsonc
{
  "global":    [ /* PermissionRule; empty in practice — OMP's config.yml has no
                    OpenCode `tools`/`permission` keys */ ],
  "agent":     [ /* PermissionRule, the agent's own rules */ ],
  "effective": [ { "action": "edit", "resource": "*", "effect": "allow", "source": "global" },
                 { "action": "edit", "resource": "*", "effect": "deny",  "source": "agent" } ],
  "source": "md",
  "path": "…"
}
```
`effective` is in evaluation order: global rules first, agent rules last. Last
match wins, so a later rule overrides an earlier one.

`POST /api/config/agents/:name` — body is an `AgentEntity` plus
`scope: "user" | "project"`. Answers
`{ success: true, message, scope, path }`.

`PATCH /api/config/agents/:name` — body is a partial `AgentEntity`. `null`
removes a field, an omitted field is left alone. `permission` (a v1 map) and
`prompt` (the v1 name for `system`) are still accepted and translated. Answers
`{ success: true, message, source, scope, path }`.

`DELETE /api/config/agents/:name` — optional body `{ scope }`. Answers
`{ success: true, message }`.

`GET /api/config/commands/:name` — same `sources` envelope as agents.
`GET /api/config/commands/:name/config` — `{ source, scope, path, legacy, config }`
with a `CommandEntity`.
`POST` / `PATCH` / `DELETE /api/config/commands/:name` mirror the agent routes;
`subtask` is accepted as the v1 name for `subagent`.

`GET /api/config/mcp` — array of `McpEntity` extended with
`{ name, scope, sectionKey: "mcpServers", legacy: false, credentialId?, authenticated }`,
merged project-first with the user file winning a shared name. `credentialId`
is the entry's `auth.credentialId` when it has one; `authenticated` says whether
that id resolves to an active row in the agent dir's `agent.db`
(`readCredentialIdsFromDb` in `credentials.js`), so a config-only read tells
signed-in from signed-out.
`GET /api/config/mcp/:name` — one such entry, or 404.
`POST` / `PATCH` / `DELETE /api/config/mcp/:name` — body is an `McpEntity`
(plus `scope` on create). Answers `{ success: true, message, path }`.

## Config entity routes on OMP (config-entity-routes.js)

`registerConfigEntityRoutes(app, dependencies)` registers the agent, command,
MCP and global-behavior routes the OpenChamber stores drive, backed by OMP's
own storage instead of an OpenCode server. Deps: `resolveProjectDirectory`,
`resolveOptionalProjectDirectory` (from `project-directory-runtime.js`), and an
optional `ompAgentDir` override that defaults to `OPENCODE_CONFIG_DIR`.

Storage (all under the OMP agent directory — `~/.omp/agent`, or a profile's
`~/.omp/profiles/<name>/agent`, overridable with `PI_CODING_AGENT_DIR`):

| Entity | User path | Project path |
|---|---|---|
| Agents | `<agent dir>/agents/<name>.md` | `<project>/.omp/agents/<name>.md` |
| Commands | `<agent dir>/commands/<name>.md` | `<project>/.omp/commands/<name>.md` |
| MCP servers | `<agent dir>/mcp.json` | `<project>/.omp/mcp.json` |
| AGENTS.md | `<agent dir>/AGENTS.md` | (read by OMP; not edited here) |

Agents and commands are markdown files; a project file is found by walking
`.omp/` from the requested directory up to the worktree root, so a definition
in a parent directory of a monorepo package counts. Only `agents/` and
`commands/` are written; a nested id (`team/reviewer`) maps onto the path.

### The JSON half is typed-unsupported

OMP's `config.yml` has no per-entity sections: there is no `opencode.json`
agent/command/MCP entry to read or write. The deleted OpenCode routes fell back
to one, so the port keeps the deleted control flow but surfaces the typed
error instead of inventing a value:

- `GET /:name/config` and `GET /:name/permissions` answer
  `501 { error, code: "OMP_UNSUPPORTED_CONFIG_SECTION" }` when no markdown file
  exists, because the OpenCode-shaped answer would have to come from the JSON
  half. When a markdown file exists the route answers it in the same shape
  (`source` is `"md"`; `"json"` is never produced).
- `GET /:name` keeps the full sources envelope: `md`, `projectMd` and `userMd`
  are real, and `json` is
  `{ exists: false, unsupported: true, code, error }` — the markdown data stays
  in the same shape without a fake `path`/`scope`/`fields`.
- `POST` (create) never consults the JSON half: OMP cannot read such an entry,
  so a differently-spelled duplicate is not a conflict. `PATCH`/`DELETE` on a
  name with no markdown file hit the same typed error as `/config`.
- `GET /:name/permissions` reads global rules from OMP's `config.yml` through
  the same reader, but OMP's settings carry no OpenCode `tools`/`permission`
  keys, so `global` is empty in practice.

### MCP mapping and omissions

An OMP `mcpServers.<name>` entry maps onto the UI's `McpEntity`. Fields with no
OMP home are omitted rather than faked:

| UI field | OMP backing |
|---|---|
| `type: "local"` | `type: "stdio"` + `command` (string) and `args` (array) |
| `type: "remote"` | `type: "http"` (or `"sse"`) + `url` |
| `command: [bin, ...args]` | `command` + `args` |
| `cwd`, `environment` | `cwd`, `env` |
| `headers`, `url` | `headers`, `url` |
| `oauth.*` (snake_case) | `oauth.*` (camelCase: `clientId`, `clientSecret`, `scope`, `callbackPort`, `redirectUri`) |
| `disabled` | the entry's `enabled` flag, plus the user file's `disabledServers` / `enabledServers` lists |
| `timeout: { execution }` | the single OMP `timeout` number |

Omitted — OMP's schema or the UI has no counterpart: `codemode`, `protocol`
(OMP's `requestIdFormat` is a different concern), `timeout.startup` and
`timeout.catalog` (OMP has one timeout), `oauth.auth_server_metadata_url`, and
OMP's `auth` / `oauth.callbackPath` / `oauth.prompt` (no UI field). An explicit
`oauth: false` has no OMP spelling and is dropped. A legacy `type: "sse"` server
reads as `remote` and is rewritten as `"http"` on the next save. A create or
update that would leave a stdio server without a `command` (or an http server
without a `url`) is rejected — OMP's schema requires both.

Like OMP, a project `mcp.json` is never rewritten for enable/disable: the
disable lives in the user file's lists. The merged list is project-first with
the user file winning a shared name, matching OMP's precedence.

Note: `lib/agents/omp-config.js` (the `/api/agents/omp/mcp` surface) defaults
its user file to `~/.omp/mcp.json`, while OMP's own resolver and the mcp schema
place it at `~/.omp/agent/mcp.json` — the path these routes use. Its `listMcp`
reports the same `credentialId`/`authenticated` pair, resolved against the same
`agent.db`.

### AGENTS.md

`GET /api/behavior/agents-md` answers `{ content, exists, path }`; `PUT`
answers `{ success: true, message: "AGENTS.md saved." }`. `413` over 1 MB, and
a `PUT` carrying `expectedContent` that no longer matches disk is refused with
`409 { error, code: "AGENTS_MD_CONFLICT" }` instead of overwriting an edit made
elsewhere.

## Public exports (config-entity-routes.js)
- `registerConfigEntityRoutes(app, dependencies)`: registers the OMP-backed config entity routes:
  - Agents: `GET /api/config/agents/:name` (sources), `GET /api/config/agents/:name/config`, `GET /api/config/agents/:name/permissions`, `POST`/`PATCH`/`DELETE /api/config/agents/:name`
  - Commands: the same five routes under `/api/config/commands/:name`
  - MCP: `GET /api/config/mcp`, `GET`/`POST`/`PATCH`/`DELETE /api/config/mcp/:name`
  - Global behavior: `GET`/`PUT /api/behavior/agents-md`
- Agent/command writes are markdown-file CRUD in the same request/response shapes the deleted OpenCode routes served; MCP writes go to OMP's `mcp.json`. Mutations report plain applied success — the runtime reads the file itself, so nothing is left to apply.
- The JSON config half has no OMP home and surfaces the typed `OMP_UNSUPPORTED_CONFIG_SECTION` error (see the section above).
- Snippets are not here: they are registered by `registerConfigSnippetRoutes` (`config-snippet-routes.js`).

## Public exports (config-settings-routes.js)
- `registerConfigSettingsRoutes(app, dependencies)`: registers the settings document routes.
  - `GET /api/config/settings` — reads the merged document through `readSettingsFromDiskMigrated({ surface: settingsSurfaceOf(req) })` and answers `formatSettingsResponse(settings)`: every registry key plus the server-computed flags (`hasManagedRemoteTunnelToken`, `hasDesktopUiPassword`, `agentMemoryFeatureAvailable`, `routingFeatureAvailable`, the LAN-access flags and the normalized device seeds). Errors are `500 { error }`.
  - `PUT /api/config/settings` — body is a partial settings document. The whole write path is `persistSettings(body, { surface })`: it gates every key through `isPersistableSettingsKey` (registry keys only — never a computed flag, never a browser-local device field, never a desktop-shell-owned key), splits profile keys into `preferences.json` per surface kind, keeps instance keys in `settings.json`, drops secrets from the answer and returns the same shape as `GET`. Errors are `500 { error }`.
  - The surface kind comes from `?surface=web|desktop|vscode|mobile` or the legacy `x-openchamber-surface` header (`settingsSurfaceOf`, `settings-files.js`); anything else reads the base document.
- Deps: `readSettingsFromDiskMigrated`, `persistSettings`, `formatSettingsResponse` (all built in `index.js`).

## Public exports (omp-settings-routes.js)
- `registerOmpSettingsRoutes(app, dependencies)`: registers the OMP-native settings knobs that have no OpenChamber settings-document home, because OMP keeps them in the agent directory's own `config.yml`.
  - `GET /api/config/cache-retention` — `{ retention: 'auto'|'short'|'long'|'none' }`. OMP keeps the Anthropic prompt cache warm itself, so this replaced the removed session-warming row: the key is `providers.cacheRetention` and OMP's default is `auto`, which is what an absent (or unrecognized) stored value reads back as. Errors are `500 { error }`.
  - `PUT /api/config/cache-retention` — body `{ retention }`, answers `{ retention, changed }` where `changed` compares against what `GET` would have answered. `400 { error }` names the four accepted values for anything else. Only `providers.cacheRetention` is written: the rest of the document and the other `providers` entries are read back and written unchanged, and a `providers` section that is not a mapping is refused rather than clobbered. A file that cannot be parsed or written (bad YAML, unwritable path) is `500 { error }`.
- Deps: `readConfigFile`, `writeConfig` (from `agent-config-files.js`, passed by `feature-routes-runtime.js`) and `configFile` (defaults to `CONFIG_FILE`, the agent dir's `config.yml`; injected in tests to drive a temp agent dir).

## Public exports (config-snippet-routes.js)
- `registerConfigSnippetRoutes(app, dependencies)`: registers the snippet routes the snippets store drives. Snippets live in `~/.omp/agent/snippets` and `<project>/.omp/snippets`, with the legacy `~/.config/opencode` trees still read.
  - `GET /api/config/snippets` — array of `{ name, content, aliases, description?, filePath, source }`.
  - `POST /api/config/snippets/expand` — body `{ text }`, answers `{ text }` with `#name` hashtags expanded.
  - `GET /api/config/snippets/:name` — one snippet, `404 { error }` when absent, `400` for an invalid name.
  - `POST /api/config/snippets/:name` — body `{ content, aliases?, description?, scope? }`, answers `{ success: true, snippet }`; `409` when the name already exists, `400` for an invalid name.
  - `PATCH /api/config/snippets/:name` — body `{ content?, aliases?, description? }`, answers `{ success: true, snippet }`; `404` / `400`.
  - `DELETE /api/config/snippets/:name` — answers `{ success: true }`; `404` / `400`.
  - Directory resolution is optional (`resolveOptionalProjectDirectory`): user-scoped snippets list without a project, and an unvalidatable `?directory=` is `400` rather than a silent fallback to another tree.
- Deps: `resolveOptionalProjectDirectory`.

## Public exports (config-skill-routes.js)
- `registerConfigSkillRoutes(app, dependencies)`: registers the skill CRUD, supporting-file and catalog routes. Sources are OMP's own disk scan; there is no second authoritative skill list to merge, so the list body is `{ skills }` with no `externalSkills` / `openCodeSkillsUnavailable` flags.
  - `GET /api/config/skills` — `{ skills: [{ name, path, scope, source, description?, content?, sources, renamable }] }`. `sources` is the `getSkillSources` envelope (`.omp`, `.opencode`, `.claude`, `.agents`, user and project), and `renamable` is the same managed-root policy `renameSkill` enforces.
  - `GET /api/config/skills/:name` — `{ name, sources, scope, source, exists }`.
  - `POST /api/config/skills/:name` — body `{ scope, source, description, instructions?, supportingFiles? }`; a project-scoped create requires a directory (`400` otherwise). Answers plain applied success.
  - `PATCH /api/config/skills/:name` — `{ renameTo }` renames the skill directory and answers `{ success, message, name }`; any other body is a partial update.
  - `DELETE /api/config/skills/:name` — deletes the skill directory.
  - `GET|PUT|DELETE /api/config/skills/:name/files/*filePath` — read/write/delete one supporting file; an unsafe relative path is `400`, a missing skill is `404`, a permission error is `403`. `GET` answers `{ path, content }`, the writes answer `{ success, message }`.
  - `GET /api/config/skills/catalog` — `{ ok: true, sources: [...], itemsBySource: {} }`; curated sources plus the user's `skillCatalogs` entries, enriched with GitHub stars/updated-at where the source is a GitHub repo.
  - `GET /api/config/skills/catalog/source?sourceId=&refresh=` — `{ ok: true, items }`, each item carrying `sourceId`, `gitIdentityId` and `installed: { isInstalled, scope?, source? }`. `400` without `sourceId`, `404` for an unknown source.
  - `POST /api/config/skills/scan` — body `{ source, subpath?, gitIdentityId? }`; `{ ok: true, items }`, `401` with the known git identities when the repo needs auth, `400` for an invalid source.
  - `POST /api/config/skills/install` — body `{ source, subpath?, gitIdentityId?, scope, targetSource?, selections, conflictPolicy?, conflictDecisions? }`; `{ ok: true, installed, skipped, … }`, `409` on conflicts, `401` when auth is required, `400` for a project install without a directory.
  - Skill routes are registered catalog-first so `/api/config/skills/:name` cannot swallow `catalog`, `scan` or `install`; directory resolution prefers an explicit request directory, then soft-falls back to the active project / `lastDirectory` so repository-local `.agents`/`.opencode` skills stay discoverable when the client omits `directory`.
- Deps: `resolveProjectDirectory`, `resolveOptionalProjectDirectory`, `readSettingsFromDisk`, `sanitizeSkillCatalogs`, `isUnsafeSkillRelativePath`. The catalog/scan/install helpers are imported directly from `lib/skills-catalog/`, and git identities from `lib/git/identity-storage.js`.

## Public exports (config-mutation-response.js)
- `buildAppliedResponse(message, details?)`: success payload for a config mutation that is already live (`{ success: true, message }`, no restart flags). `details` carries the file the write landed in (`{ path, scope, source }`) so the caller can name the config file that changed.

## Public exports (auth-state-runtime.js)
- `createOpenCodeAuthStateRuntime(dependencies)`: creates runtime for managed OpenCode auth password state and request headers.
- Returned API:
  - `getOpenCodeAuthHeaders()`
  - `isOpenCodeConnectionSecure()`
  - `ensureLocalOpenCodeServerPassword(options?)`

## Public exports (core-routes.js)
- `registerServerStatusRoutes(app, dependencies)`: registers status/system endpoints:
  - `GET /health`
  - `POST /api/system/shutdown`
  - `GET /api/system/info`
 - `registerAuthAndAccessRoutes(app, dependencies)`: registers browser auth/session exchange and API access middleware:
   - `GET /auth/session`
   - `POST /auth/session`
   - `GET /auth/passkey/status`
   - `POST /auth/passkey/authenticate/options`
   - `POST /auth/passkey/authenticate/verify`
   - `POST /auth/passkey/register/options`
   - `POST /auth/passkey/register/verify`
   - `GET /api/passkeys`
   - `DELETE /api/passkeys/:id`
   - `POST /api/auth/reset`
   - `GET /connect`
   - `POST /api/system/probe-url`
   - `app.use('/api', ...)` auth/tunnel guard
- `registerSettingsUtilityRoutes(app, dependencies)`: registers small settings utility endpoints:
  - `GET /api/config/themes`
  - `POST /api/config/reload` — restarts OpenCode on request. Config edits no longer need it; it stays for the changes that cannot be hot-applied (OpenCode binary, port, managed/external switch) and as a manual recovery. Managed OpenCode restarts and returns `requiresReload: true`. External OpenCode returns `requiresManualRestart: true` (changes are already on disk; the connected server must be restarted outside OpenChamber).
- `registerCommonRequestMiddleware(app, dependencies)`: registers shared request middleware stack:
  - conditional JSON body parser behavior for `/api/*` vs non-API requests
    - The `/api` branch parses JSON only for a named prefix allowlist (`/api/config/settings`, `/api/config/cache-retention`, `/api/config/{agents,commands,mcp,snippets,skills}`, the project/fs/git/terminal families, …); every other `/api` request reaches its route without a body, so a new route that reads `req.body` must be added to that list or mount its own `express.json()`.
  - URL-encoded parser setup
  - request logging middleware
  - `dependencies.skipBodyParsing(req)` names a request both parsers leave alone, so its body reaches its route untouched; the isolated-spaces dispatcher uses it for `/api/spaces/<id>/...`, which it streams into a space

## Public exports (cli-options.js)
- `parseServeCliOptions(options)`: parses serve CLI flags and environment-derived defaults:
  - Port/host/ui-password
  - Tunnel provider/mode/config/token/hostname
  - Legacy `--tunnel` shorthand normalization

## Public exports (cli-entry-runtime.js)
- `runCliEntryIfMain(dependencies)`: detects direct CLI execution and runs server startup with parsed CLI options.

## Public exports (server-utils-runtime.js)
- `createServerUtilsRuntime(dependencies)`: creates server utility runtime for OpenCode orchestration helpers.
- Returned API:
  - `setOpenCodePort(port)`
  - `waitForOpenCodePort(timeoutMs?)`
  - `buildAugmentedPath()`
  - `parseSseDataPayload(block)`
  - `fetchAgentsSnapshot()`
  - `fetchProvidersSnapshot()`
  - `fetchModelsSnapshot()`
  - `setupProxy(app)`

## Public exports (shutdown-runtime.js)
- `createGracefulShutdownRuntime(dependencies)`: creates graceful shutdown runtime for managed OpenCode and web server teardown sequencing.
- Daemon signals, `POST /api/system/shutdown`, and embedded `stop()` share one shutdown promise. Guest admission closes synchronously before any await. Cleanup stops the relay reconciliation timer, guest viewers, realtime proxy, relay host, dictation worker and session runtimes before draining guest services, including pending starts. Each cleanup is best-effort and runs once per shutdown, including after partial startup. A hard kill still requires the separate crash/SIGKILL recovery work; no persistent registry or boot reaper is provided here.
- Register TCP connection tracking before the HTTP server starts listening. After stopping owned runtimes and OpenCode, HTTP shutdown closes the listener and all remaining sockets, including WebSocket upgrades and unanswered upgrade requests accepted during cleanup. This prevents client reconnects from holding Desktop open until the HTTP close deadline. Each runtime still owns its protocol cleanup; socket teardown runs afterwards and preserves the existing terminal and process grace periods.
- Returned API:
  - `gracefulShutdown(options?)`
  - `trackServerConnections(server)`: call once before listening; closed sockets leave the tracking set, and the server close event removes the connection listener.

## Public exports (server-startup-runtime.js)
- `createServerStartupRuntime(dependencies)`: creates runtime for server bind/startup tunnel and process handler wiring.
- Returned API:
  - `resolveBindHost(host)`
  - `startListeningAndMaybeTunnel(options)`
  - `attachProcessHandlers(options)`

## Public exports (static-routes-runtime.js)
- `createStaticRoutesRuntime(dependencies)`: creates runtime for static dist resolution and static route registration.
- Returned API:
  - `registerStaticRoutes(app)`

## Public exports (feature-routes-runtime.js)
- `createFeatureRoutesRuntime(dependencies)`: creates runtime for main feature route registration orchestration.
- Returned API:
  - `registerRoutes(app, routeDependencies)`

## Public exports (opencode-resolution-runtime.js)
- `createOpenCodeResolutionRuntime(dependencies)`: creates runtime for OpenCode binary/source snapshot resolution.
- Returned API:
  - `getOpenCodeResolutionSnapshot(settings)`: returns configured/resolved OpenCode binary details plus effective managed-launch fields (`launchBinary`, `launchArgs`, `launchWrapperType`) when applicable.

## Public exports (tunnel-wiring-runtime.js)
- `createTunnelWiringRuntime(dependencies)`: creates runtime for tunnel service construction and tunnel route registration.
- Returned API:
  - `initialize(app, initialPort, hasUiPassword)`

## Public exports (startup-pipeline-runtime.js)
- `createStartupPipelineRuntime(dependencies)`: creates runtime for terminal wiring, proxy/bootstrap scheduling, static route registration, and server startup/listen flow.
- Returned API:
  - `run(options)`

The pipeline binds the OpenChamber listener and publishes its active port
before starting managed OpenCode. The managed custom tool therefore receives
an authoritative loopback callback URL even when OpenChamber binds port `0`.

## Public exports (openchamber-routes.js)
Browser completion checks use `appType=web&updateStatus=true` to stay on the
Desktop Host's native updater. A rejected native restart is retained in the
server process and returned to these polls as `DESKTOP_UPDATE_RESTART_FAILED`;
ordinary availability checks remain usable so a browser reload can offer a
retry. Starting another installation clears the previous restart error.
The shared UI's `lib/web-update.ts` parses install/check responses and waits
for the installed native target version, rather than treating absence of a
newer release as installation success. Poll requests have individual deadlines
within a ten-minute overall deadline.

- `registerOpenChamberRoutes(app, dependencies)`: registers OpenChamber endpoints:
  - `GET /api/openchamber/update-check`
  - `POST /api/openchamber/update-install`
    - Desktop-managed hosts delegate authenticated Web update requests to the Electron main process, which checks, downloads, and applies the update through `electron-updater` before restarting the host.
    - Foreground servers running under a systemd user unit queue installation in
      a separate transient unit and restart the configured service afterwards.
      `OPENCHAMBER_SYSTEMD_UNIT` overrides the default `openchamber.service`.
    - On Windows the install-and-restart script is written to
      `<data dir>/update-install.cmd` before the response and run with
      `cmd.exe /c <file>`. A newline ends a `cmd.exe /c` command line, so the
      same script passed as an argument ran nothing and exited 0; the batch
      file keeps every line. The package-manager line is `call`ed because
      npm, pnpm and yarn are `.cmd` shims that would otherwise end the script,
      the pre-install pause is a loopback `ping` because `timeout` rejects a
      detached child's stdin, and the file deletes itself on its last line
      because the restart command carries the server's flags. If the file
      cannot be written the route answers 500 and the server keeps running.
      The listener is closed before the batch is spawned: on Windows the
      detached child inherits the listening socket and would hold the port
      for the whole batch, so the restart inside it failed with "port already
      in use" and the update ended with no server.
  - `GET /api/openchamber/models-metadata`
  - `GET /api/zen/models`

## Public exports (pwa-manifest-routes.js)
- `registerPwaManifestRoute(app, dependencies)`: registers PWA manifest endpoint with dynamic app-name resolution and recent-session shortcuts:
  - `GET /manifest.webmanifest`

## Public exports (project-icon-routes.js)
- `registerProjectIconRoutes(app, dependencies)`: registers project icon routes and owns icon storage/discovery flow:
  - `GET /api/projects/:projectId/icon`
  - `PUT /api/projects/:projectId/icon`
  - `DELETE /api/projects/:projectId/icon`
  - `POST /api/projects/:projectId/icon/discover`

## Public exports (proxy.js)
- `registerOpenCodeProxy(app, dependencies)`: registers OpenCode proxy routes and middleware.
- Owns:
  - SSE forwarders: `GET /api/global/event`, `GET /api/event`
    - Downstream heartbeats keep clients and intermediaries alive, while a separate upstream-only stall watchdog closes the downstream response when OpenCode stops producing bytes so clients reconnect instead of trusting synthetic heartbeats indefinitely. Each watchdog reset uses the current load-aware timeout, matching the shared event transport.
  - Session message forwarder: `POST /api/session/:sessionId/message`
  - Session list and detail: `GET /api/session`, `GET /api/session/:sessionID`
    - Both are sanitized to an allowlist of `SessionInfo` fields, then get archive state folded in from `lib/openchamber-sessions/archive-store.js`, because OpenCode 2.x has no archive route, plus any `metadata` entry `lib/openchamber-sessions/session-metadata-store.js` has not migrated from the legacy file yet. An unknown answer from either store leaves the upstream record untouched rather than reporting a session as un-archived or dropping its metadata.
  - Upstream paths are the request paths. OpenCode 2.x serves everything under `/api/*` itself, so the mount prefix Express strips is put back instead of being rewritten away.
  - There is no interactive OAuth forwarder any more: v2 connects providers through `/api/integration/*`, whose OAuth steps return immediately and are polled, so no route needs a longer deadline than the ordinary one.
  - Generic `/api/*` forwarding with hop-by-hop header filtering
  - Session list forwarding on every platform, preserving V2 query filters and pagination cursors. Global reads use OpenCode's cross-directory list rather than merging per-project pages on Windows.
  - OpenCode readiness gate for proxied `/api` requests
  - Worktree checkout gate before directory-scoped upstream reads and writes

Git bootstrap must reach `git-ready` before OpenCode can cache a new worktree's
project identity or config. Setup scripts may still be running; the optional UI
setup wait remains separate. Failed or timed-out checkout returns 503 without
forwarding. The shared draft creator keeps the project directory selected until
creation returns, because preview paths have no bootstrap state.

This server gate covers web, Electron, hosted mobile, and Capacitor connections.
The VS Code extension owns its separate Git and proxy implementation.

## Public exports (watcher.js)
- `createOpenCodeWatcherRuntime(dependencies)`: creates global event watcher runtime backed by the shared upstream SSE reader.
- Returned API:
  - `start()`
  - `stop()`
- Behavior:
  - Waits for OpenCode readiness before attaching the watcher.
  - In production wiring, subscribes to the shared global message-stream hub instead of opening its own `/api/event` connection.
  - Can still create its own `/api/event` reader when no shared hub is provided, which keeps module tests and isolated reuse simple.
  - Reuses event-stream parsing, `Last-Event-ID`, stall timeout, and reconnect behavior.
  - Translates each v2 wire event through `lib/event-stream/translate-v2.js` before handing it to notification/session side effects, so those consumers keep speaking the server's own event vocabulary.

## Storage and configuration
- Provider auth: `~/.local/share/opencode/opencode.db` table `credential` (read-only), with `auth.json` as the legacy fallback; OpenCode 2.x owns credentials.
- Provider credentials for the ported consumers (quota, TTS, routing): OMP's `<agent dir>/agent.db` table `auth_credentials` (read-only), then `providers.<id>.apiKey` in `<agent dir>/models.yml`, then the provider's catalog environment variable — see "Public exports (credentials.js)".
- Session archive state: `sessions-archive.json` under the OpenChamber data dir.
- Session metadata (goal progress, the assist recap, the obligatory-context cursor, pinned notes) lives on the OpenCode session record, written with `PATCH /api/session/{id}` (OpenCode 2.0.15+, the minimum `compatibility.js` enforces). OpenCode replaces the whole object, so `sessionMetadataStore.setSessionMetadata` reads the record, applies the JSON Merge Patch and writes the result, one write per session at a time; a record that cannot be read stops the write. Every reader and writer (routes, goal loop, session assist, session knowledge, obligatory context, notifications) goes through `sessionMetadataStore.get` / `setSessionMetadata`. Older OpenChamber versions kept this state in `sessions-metadata.json` under the data dir. Its entries are the newest metadata their sessions have: the proxy lays them over OpenCode's records, a session's next write pushes its entry, and a sweep after OpenCode starts pushes the rest (a session OpenCode no longer knows is dropped, any other failure waits for the next write or start). The emptied file is renamed to `sessions-metadata.json.migrated`. Archive mutations still run one transaction at a time in the archive store.
- User config: `<config dir>/opencode.json(c)` where the config dir is `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`. The v1 `config.json` is not read.
- Project config: `<workingDirectory>/.opencode/opencode.json(c)` first, else `<workingDirectory>/opencode.json(c)`.
- Custom config: `OPENCODE_CONFIG` env var path.
- Rate limit config: `OPENCHAMBER_RATE_LIMIT_MAX_ATTEMPTS`, `OPENCHAMBER_RATE_LIMIT_NO_IP_MAX_ATTEMPTS` env vars.

## Notes for contributors
- This module serves as foundation for OpenCode-related server utilities.
- Route ownership moved to module-level `routes.js`; `index.js` wires dependencies only.
- All file writes include automatic backup before modification.
- Config merging follows priority: custom > project > user.
- UI auth uses scrypt for password hashing with constant-time comparison.
- Tunnel auth treats `host.docker.internal` as local-only when the socket remote IP is private/loopback.

The behavior `GET /api/behavior/agents-md` response includes `path`, the effective
server-side filename, whether or not the file exists. Settings displays this
path without deriving a directory from the browser environment. A `PUT` may send
`expectedContent` (the content the editor loaded, `null` for no file); when the
file on disk no longer matches, the write is refused with `409` and code
`AGENTS_MD_CONFLICT` instead of overwriting an edit made elsewhere.

## Managed OpenCode config layer (managed-config-file.js)

OpenChamber injects its own OpenCode plugins through a file it owns rather than
through the process environment, because an environment variable cannot change
under a running child.

- Contract: the managed child gets `OPENCODE_CONFIG=<data-dir>/opencode.managed.json`.
  The file contains only `plugins`: `-opencode.browser` first, then the absolute
  directory of every OpenChamber plugin currently switched on. OpenCode's
  built-in browser tools need OpenCode's own desktop app to attach a browser;
  OpenChamber does not, so they would always fail with `browser.disconnected`
  and steer agents away from `openchamber_web`. A project config listing
  `opencode.browser` re-enables it. The fallback path merges the same entry. Its layer sits above the user's
  global `opencode.json` and below their project config.
- `OPENCODE_CONFIG_CONTENT` is passed through untouched, so whatever the user
  put there still applies.
- `OPENCHAMBER_AGENT_TOOL_URL` and a fresh `OPENCHAMBER_AGENT_TOOL_TOKEN` are
  always in the child environment, including while every managed tool is off —
  a tool switched on later then reaches a process that can already call back.
- `persistSettings` rewrites the file (temp + rename) whenever
  `agentControlToolEnabled`, `agentWebToolEnabled`, `agentMemoryToolEnabled`,
  `agentNotifyToolEnabled` or `agentToolsCodeMode` changes. Plugin directories are written before the
  file names them, and a disabled plugin is removed from the list. OpenCode
  reloads within a couple of seconds; no restart is involved.
- Fallback: when the user's own environment already sets `OPENCODE_CONFIG`,
  OpenChamber does not take it over. It merges its plugin directories into
  `OPENCODE_CONFIG_CONTENT` instead, and those installs keep the old behavior —
  a managed-tool toggle needs an OpenCode restart to take effect.

The embedded server controller exposes `getManagedOpenCodePreflight()` for
desktop bootstrap. It shares the lifecycle's current CLI validation promise,
including while validation is in flight. It returns false before validation
starts, after failure, during shutdown, or for external OpenCode. Restart clears
the previous result, and readers discard results from a replaced preflight.
This checks CLI compatibility, not server health; the normal startup flow still
owns connection readiness. Explicit user compatibility checks remain fresh.

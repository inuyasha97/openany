# Settings sections

One directory per Settings page. `shared/` holds the page chrome and controls
every page is built from; see `.agents/skills/settings-ui-patterns/SKILL.md` for
which primitive to reach for.

## Autosave on the OpenCode configuration pages

`agents/`, `commands/`, `skills/`, `mcp/`, `plugins/` and `behavior/` edit files
that OpenCode v2 watches: it picks up a change and applies it within a second or
two, and the server answers every config mutation with a plain
`{ success, message }`. There is no restart to wait for and no restart state to
show, so these pages carry no Save, Apply or Discard button.

The contract, implemented by `shared/SettingsAutosave.tsx`:

- Toggles, chips, selects, pickers and row removals write immediately. They call
  `requestSave()` right after setting state; the hook runs the save after the
  render commits, so the routine reads the value the control just set.
- Text fields write when they lose focus. `SettingsPageLayout` takes the hook's
  `onBlurCapture`, which fires for any input, textarea or editor inside the
  page, so individual fields need no handler. Long editors (the skill document,
  a plugin file) also write on Cmd/Ctrl+Enter.
- A page's save routine compares the form against what it last wrote and returns
  `AUTOSAVE_UNCHANGED`, `AUTOSAVE_SAVED` or `autosaveFailed(reason)`. Success is
  silent and there is no inline "Saving…"/"Saved" indicator: a write is not
  something the user waits for. A failure is an error toast,
  "Couldn't save: <reason>", raised by the hook itself.
- **One page, one save routine.** A section that writes its own request still
  reports through the page: it hands its save routine up via `registerSave`, and
  the page's save runs it, so a failure is reported once.
- Saves run serially. A save request received during a write queues one follow-up
  using the latest committed form state. Unmounting prevents that follow-up.

Do not route these pages through `reportSettingsSaveState` / `showSaveStatus`.
That indicator belongs to settings persisted by `updateDesktopSettings`, and it
is deliberately silent on success.

### Reconciliation

OpenCode re-reads files after writes. Store refreshes can arrive before the
save promise settles, while the user is already editing the next version.
Commands compare incoming values with both the saved baseline and the normalized
submitted snapshot. Successful saves keep that normalized baseline for late
echoes. Agents and MCP preserve dirty drafts and their baseline during refreshes
of the same entity; successful saves advance that baseline. Skills and plugins
preserve dirty drafts while updating their server baseline. A failed write leaves
the form dirty for retry. Superseded skill detail reads are ignored.
Behavior only normalizes the submitted prompt if the user has not changed it.

Scope reconciliation to the selected entity and Settings directory. Selecting
another entity hydrates its form, and an older save completion must not replace
its baseline. Runtime endpoint changes remount Settings through the keyed
`SyncProvider` in `App.tsx`.

### Creating an entity

A new agent, command, skill or MCP server is a draft in its store, not a file.
Nothing is written while the draft is being filled in: the page shows Create and
Cancel, Create validates (name, and whatever else the entity needs) and writes
once, and Cancel drops the draft. Abandoning a half-typed entity leaves nothing
on disk. Once the entity exists, the page switches to the autosave rules above.

`skills/` follows the same split for supporting files: editing an existing file
writes when the dialog closes, while a new file is only created on confirm.

## Providers

`providers/` is not an autosave page. Connecting a provider is an action, not a
setting: an API key is submitted, an OAuth flow is completed, a credential is
removed. OpenCode owns the credential store and announces every change
(`credential.*`, `provider.updated`, `model.updated`), and it watches the config file a custom
provider is written to, so the page never asks for a reload or a restart: it
refetches its own provider sources and integrations and lets the catalog
events refresh the stores. (The old "nudge" went through `/api/config/reload`,
which restarts a managed OpenCode and showed the reload overlay.)

The "Add provider" list is `GET /api/integration` minus the integrations that
already have a connection and minus MCP OAuth registrations (`mcp_*`); v2's
`GET /api/provider` lists only what is configured or connected right now, so
it cannot offer anything new.

### MCP servers

The MCP page lists and toggles servers through the agent runtime
(`listMcpServers` / `connectMcpServer` / `disconnectMcpServer`, backed by the
server's `mcp.json` reader). OAuth sign-in for a remote MCP server is gone:
it used the OpenCode integration surface, and this runtime exposes no
equivalent yet, so the page no longer offers it.

## Entity shapes: OpenCode 2 only

Every OpenCode entity these pages read and write speaks the v2 shape defined in
`packages/web/server/lib/opencode/DOCUMENTATION.md`, section "Entity routes (v2
shapes)". The server reads v1 files too and rewrites them in place as v2; the UI
only ever sends v2.

| Entity | What the page reads and writes |
|---|---|
| Agent | `system` (the markdown body), `description`, `model` as `provider/model#variant`, `mode`, `steps`, `hidden`, `color`, `request.body.temperature` / `request.body.top_p`, and an ordered `permissions` rule list |
| Command | `template` (the markdown body), `description`, `agent`, `model` with `#variant`, `subagent` |
| MCP server | `type` (required), `command` / `url`, `environment`, `headers`, `disabled`, `codemode`, `timeout: { startup, catalog, execution }`, snake_case `oauth` |
| Provider | `package` with the `aisdk:` prefix, `settings.baseURL`, `headers`, `body`, models keyed by id with `modelID`, `capabilities`, `variants`, `cost.cache.read/write`, `disabled` |
| Plugin | `{ package, options }`, serialized as a bare string when there are no options |

Two consequences worth knowing:

- **Edit the stored entry, never the resolved one.** `AgentInfo` and the model
  catalog are what OpenCode resolved: built-in defaults, global config and live
  session grants are already merged in. Writing that back would bake them into
  the file. `agents/AgentsPage.tsx` therefore reads
  `GET /api/config/agents/:name/config`, and the
  commands store reads `GET /api/config/commands/:name/config` because the v2
  `CommandInfo` carries only a name and a description.
- **`request` is replaced wholesale.** A PATCH that sends `request` overwrites
  the whole block, so `AgentsPage` merges the fields it owns into the stored
  `request` instead of sending only what changed.

`disabled: true` is not a soft toggle: OpenCode 2 drops the entity entirely, so
no page exposes it as an on/off switch for agents. For MCP servers `disabled` is
the documented way to keep a server configured but inactive, and the page's
"Enable" checkbox writes it.

### Tool permissions and approval

There is no per-agent permission editor. The page used to expose one built on
OpenCode 2's ordered `{ action, resource, effect }` rules, but OMP reads neither
those rules nor a `mode` field from an agent's markdown — its agent parser wants
`name`, `description`, `tools`, `spawns`, `model`, `thinkingLevel` and the other
fields in `src/discovery/helpers.ts`, and its policy lives in the settings file
instead. A control that saved a key nothing reads is a false safety guarantee, so
it was removed rather than left in place; the same reasoning applies to the model
picker's per-tool summary, which rendered those same dead rules.

What decides whether a tool call reaches the user is OMP's own
`tools.approvalMode` (`always-ask` / `write` / `yolo`) and its per-tool
`tools.approval` record. Settings → Sessions → **Tool approval** writes the mode
through `GET|PUT /api/config/tool-approval`, which is real over OMP: with
`always-ask`, a session's shell call raises the approval dock. `tools.approval`
is intentionally not surfaced yet.

Below the built-in tools the editor lists one row per MCP server from the
Settings directory's config (`useMcpConfigStore`), keyed `<server>_*`, which
OpenCode matches against every tool the server exposes. Every configured server
is listed, not only the connected ones, so a rule can be set while a server is
disabled or failing; the live status from `useMcpStore` is shown beside the
name as a hint. A single MCP tool (`<server>_<tool>`) is still reachable
through the custom key input.

### The legacy-format note

Config reads report `legacy: true` when the entity's file still uses v1
spellings, and mutations answer with the `path` they wrote.
`shared/SettingsLegacyFormatNote.tsx` turns that into one quiet line at the top
of the page; the file is never moved, so the note has no action.

# OpenAny function status — granular checklist

One row per thing a person can actually invoke. `Status` means *driven on a real
runtime and observed*, not "the code looks right".

| Status | Means |
|---|---|
| `PASS` | Driven end to end; the expected result was observed. Evidence column says what was seen. |
| `FAIL` | Driven; it did not do what it promises. Root cause is in §I. |
| `UNTESTED` | Never driven here. No claim either way. |
| `BLOCKED` | Cannot be driven from this harness; reason given. |
| `ABSENT` | The control does not exist for OMP; the capability is declared `false` with its reason. |

Harness: macOS arm64, `bun packages/web/server/index.js --port 4111` (real `omp`
18.1.11, the repo's built UI), driven over CDP; plus the packaged Electron app
(`packages/electron/dist/mac-arm64/OpenAny.app`) where noted. Windows and Linux
were not run.

## A. Composer — sending a turn

| Function | Status | Evidence |
|---|---|---|
| Send a text prompt and get an answer | `PASS` | `Reply with only the word ONE.` → `ONE`, badge `DeepSeek V4 Flash · 2.8s`. |
| Answer text renders while streaming | `PASS` | Transcript length stepped 436→731→930→1257→1409→1625 inside 0.76 s. |
| One bubble per prompt (no duplicate) | `PASS` (was `FAIL`) | A marker in the prompt renders exactly once; §I.1. |
| Model picker opens the real catalog | `PASS` | 30+ models listed (DeepSeek, GLM, GPT, Grok, Kimi, Claude). |
| Picked model is the model that runs | `PASS` (was `FAIL`) | Picked `GLM-5.3-Flash`; the turn's badge read `GLM-5.3-Flash · 3.7s`; §I.2. |
| Thinking effort / variant per model | `PASS` | Picked `High` in the composer's effort control; the session file records `thinking_level_change: ["high"]`, and the same file shows `model_change` from `deepseek-v4.1-flash` to `deepseek-v4-flash` — the composer's model reached OMP too. |
| Fast mode toggle | `ABSENT` | No control calls `setFastMode`; OMP's `/fast` command toggles it and its output is now visible; §I.9. |
| Agent picker in the composer | `ABSENT` | `agentSelection: false` — OMP picks the subagent inside the model's own `task` call. |
| Attach an image | `PASS` | Dropped a 64×64 magenta PNG with a white diagonal on the composer; the chip appeared, and the session file shows the user message carrying three `image/webp` blocks (the app converts on attach). The model answered "Magenta (with a white diagonal band running from corner to corner)" — it saw the image. |
| Attach a non-image file | `ABSENT` | `attachmentKinds: "images"`; other files are sent by `@path` mention. |
| `@` file mention reaches the model | `PASS` | Typed `@package.json` plus "What is the version field in that file?" in a session rooted at the repo; the model answered `0.1.2` — the value in that file. |
| `@` mention picker (popup list) | `FAIL` (by design) → `FIXED` | Typing `@` — bare, and as `@packages/ui/src`, in a managed chat and in a repo-rooted session — opens **no** popup, while `/` and `#` do. `composer/language/triggers.ts: matchMention()` returns `null` on purpose ("the `@`-mention picker searched the runtime's file index, which OMP does not expose"). The hint that promised it is fixed; §I.11. |
| `/` command or skill | `FIXED` | Typing `/` opens the Command Palette listing OMP's 30 commands; sending one now renders its output ("Shell Command 0.1s /usage"). Before the fix the command produced nothing visible at all; §I.8. |
| `#` snippet | `PASS` | Typing `#` with real key events opens the snippet picker: "+ Add new snippet" and the user's own `#expandx` (GLOBAL), with "↑↓ navigate · Enter select · Esc close". The earlier `UNTESTED` was a harness limit (DOM insertion instead of real key events). |
| `!` shell prefix | `FIXED` | The composer advertised "`!` for shell" while a leading `!` reaches the model (`!echo shell-check` was answered by `DeepSeek V4 Flash · 3.7s`). OMP has no shell command in its RPC, and `ChatInput` pins `inputMode` to "normal" for that reason. The hint no longer promises a shell (all 13 locales) and the dead `chat.chatInput.placeholder.shell` string is gone; §I.5. |
| Dictation | `BLOCKED` | Needs a microphone/audio device. |
| Focus mode toggle | `PASS` | Clicking it collapses the narrow rail: the rail widths measured `[28, 44]` before and `[44]` after. The earlier "no change" reading only measured the composer width. |
| Permissions mode (`ask every time` → …) | `PASS` | Clicking cycled the control from "Permissions: ask every time" to "Permissions: accept everything". |
| Send while the session is busy (queue) | `PASS` | Mid-turn, with text in the composer, the composer exposes **both** "Queue message" and "Stop generating"; pressing Enter queued it (the transcript shows a queued chip) and the turn carried on. The earlier `UNTESTED` was the harness: text inserted into the DOM instead of typed never reached the composer. |
| Stop a running turn | `PASS` | The composer renders "Stop generating" while a turn is in flight (seen at 0.7 s and 2.1 s into two turns) and it disappears the moment the turn ends. Clicking it during the model's thinking phase ended the turn with no answer and freed the composer. A mid-answer abort could not be caught: this model finishes a 400-line answer in 5.7 s. |
| Visible progress before the first token | `PASS` (was `FAIL`) | Measured on the same 565-message session the report named: the transcript renders in 2.5 s and a send puts the composer into "Stop generating" 1.3 s after Enter. OMP itself reports `isStreaming: true` 1.1 s after the prompt is accepted. The reported 14 s of silence does not reproduce; §I.3. |
| Parallel run ("Run on several models") | `PASS` (opens) | The picker's leading action exists and clicking it puts the UI in a parallel state; a multi-model send was not run. |
| BTW side composer (`/btw`) | `PARTIAL` | `/btw what is 2+2?` opens a side panel with its own composer ("Ask your question") carrying the question and its own model/effort row. The side answer was not confirmed, and the main transcript stayed clean. |
| Permission approval prompt (approve / reject) | `PASS` | With `tools.approvalMode: always-ask` in OMP's `config.yml` (OMP's own knob; its default is `yolo`, which is why earlier attempts ran unprompted), a bash prompt raised the dock: "Allow tool: bash Command: echo approval-check 1 of 1". Expanding it revealed **Approve** / **Deny** with a `submit` button. Approving ran the command — output `approval-check`, `Exit 0, 0.04s`, and the model reported "Tool execution approved and working". A second request denied left it unexecuted — "bash call denied by user — echo denied-check never executed. Result: no output, no exit code" — so the gate is per call. `config.yml` was restored byte-for-byte afterwards (855 bytes, no `tools` key). |
| Permission rules from the UI | `PASS` (write) | Settings → Agents → a custom agent → **Tool Permissions** offers one row per tool (Default for all tools, Shell, Edit, Read, Glob, Grep, Patch, Webfetch, Websearch, Skill, Subagent, Question, External Directory, Openchamber…) with inherit/allow/ask/deny chips and no Save button. Clicking `ask` on the Shell row wrote `permissions: [{ action: shell, resource: "*", effect: ask }]` into `~/.omp/agent/agents/perm-probe.md` — OMP's own agent file — and the Mode row wrote `mode: primary`. The probe agent was deleted afterwards (route answered 200, the directory is empty, `config.yml` untouched). **See §I.10: OMP does not read either key.** |
| Model `ask` form answered | `PASS` (was `FAIL`) | The model had no `ask` tool because the adapter spawned `omp --mode rpc`, where OMP's `hasUI` is false and `AskTool.createIf` therefore returns null. Spawning `--mode rpc-ui` creates it: `get_state`'s `dumpTools` went from 11 tools to 12 with `ask` added. Verified in the app — the prompt raised the form dock with "Red — The color red." / "Blue — The color blue." and `dismiss` / `submit`; choosing Red and submitting closed the dock and the turn recorded the `ask` call with that answer; §I.13. |
| Goals / small-model affordance | `UNTESTED` | The composer says "Goals need a Small Model. Sign in to a model provider or pick one in Settings → Sessions" — the affordance names what it needs instead of promising a turn it cannot run. |
| Ask other models / multi-run | `UNTESTED` | Offered by the answer menu and the picker. |

## B. Chat message actions

| Function | Status | Evidence |
|---|---|---|
| Copy message text | `PASS` | Assistant message's copy put `ONE` on the clipboard. |
| Pin into context (survives compaction) | `PASS` | Pin state set on the message (`aria-pressed`). |
| Continue from this answer → menu | `PASS` | Opens: Fork from here / Start new session from this answer / Ask other models / Start new multi-run. |
| Fork from here | `PASS` | "Continue from this answer" → "Fork from here" created session `01a11f67-…` with `parentSessionPath` set, whose transcript holds exactly the two messages up to the cut (the `@package.json` prompt and its `0.1.2` answer) while the original still holds its nine. No dialog appeared; the fork is immediate. |
| Start new session from this answer | `UNTESTED` | |
| Ask other models / multi-run from an answer | `UNTESTED` | |
| Revert (undo) a message | `ABSENT` | `revert: false` — OMP keeps no file snapshots. |
| Per-turn file diff | `ABSENT` | `turnDiff: false`. |
| Scroll to bottom | `UNTESTED` | |
| Turn stats / context sources readouts | `PASS` (renders) | Turn stats, tokens, cost and "8 skills" render after a turn. |
| Reasoning traces visible | `PASS` | With Settings → Chat → "Show Reasoning Traces" **on**, the transcript renders the model's thinking ("Thinking Same structure: shared factor 29, 31 > 27, so yes."). The setting defaults to on and was off in this browser profile — which is why an earlier note here called the reasoning hidden; it was the setting, not the renderer. |

## C. Sessions

| Function | Status | Evidence |
|---|---|---|
| List real sessions | `PASS` | 75 sessions of this machine listed. |
| New session (draft) | `PASS` | `New session` → send created one and it ran. |
| Open / switch session | `PASS` | Sidebar row opens the transcript. |
| Open a session whose folder was deleted | `PASS` (was `FAIL`) | Now says "Session could not be loaded — This session's folder no longer exists: /Users/phonnt/Documents/00.AI/AI-GUI. OMP cannot open a session whose folder is gone." §I.4. |
| Copy session ID | `PASS` | Toast "Session ID copied". |
| Archive session | `PASS` | Confirmation dialog "Archive session? … Cancel / Archive". |
| Export session as Markdown | `PASS` (was `FAIL`) | A row whose folder is gone now says "This session's folder no longer exists: … OMP cannot open a session whose folder is gone." A healthy session's export was not confirmed (no download was captured). |
| Rename | `PASS` | Menu → Rename opens an inline input ("Rename", pre-filled with the title); typing `audit-renamed` + Enter put that name in the sidebar. |
| Rename with AI | `UNTESTED` | Menu item present; not run (costs a model call). |
| Pin session | `PASS` | Menu → Pin session; the same menu then reads "Unpin session", so the state flipped. |
| Track as in work | `PASS` | The row's "Track as in work" action moved the session under a new **in work** group in the sidebar. |
| Move to folder | `UNTESTED` | The item is in the session menu in some views and gone in others (it was present with one display mode and absent with another), so it is a conditional affordance; the pass that clicked it found no surface. |
| Open in Side Panel (beta) | `PASS` (opens) | Choosing it moved the app to a side-panel session: the URL became `?session=01a11fc9-0310-7000-8a4f-d7f4408c6156`. |
| Move to worktree | `UNTESTED` | Needs a worktree. |
| Delete | `PASS` (dialog + route) | Menu → Delete raises "Delete session? \"…\" will be permanently deleted." with **Never ask / Cancel / Delete**. The delete itself was confirmed through the route the UI calls: `DELETE /api/agents/omp/sessions/:id` answered `{"ok":true}` for two sessions created for the test, neither is listed afterwards, and their session files are gone from `~/.omp/agent/sessions/` (a real removal, not a soft delete). The confirmation click was not driven on the intended row: the sidebar never rendered one for the throwaway (it lists the selected directory's sessions), so that dialog was cancelled instead of used. |
| Search sessions | `PASS` | "Search sessions" opens an input reading "Press Enter to search / Esc to clear"; typing `thinking` changed the list. |
| Select sessions (bulk) | `PARTIAL` | Entering the mode shows "0 selected" in the sidebar; no per-row checkbox was found by the probe, so row selection is unverified. |
| Display mode: Grouped / Timeline / Manual | `PASS` | The menu lists View (Grouped/Timeline/Manual), Sort projects (A→Z/Z→A/Newest/Recent) and Sort worktrees (Recent activity/Manual); choosing **Timeline** changed the sidebar's grouping. Sorts and scope are listed but were not applied. |
| Display mode: sort (A→Z, Newest, Recent activity) and scope (All/One project) | `UNTESTED` | Listed in the same menu; not applied. |
| Show more sessions (pagination) | `UNTESTED` | The button responds; the probe's row selector found no rows to count. |
| Project menu: New session / Edit / Close project | `UNTESTED` | The menu did not open in the probe pass. |

## D. Panels

| Function | Status | Evidence |
|---|---|---|
| Git panel: status, branch, sync, stashes | `PASS` (renders) | Shows `main`, "Working tree clean", a sync control. Sync itself needs a remote — `UNTESTED`. |
| Changes panel | `PASS` (renders) | "Changed: 0 — working tree clean, no changes to display". |
| Terminal panel | `PASS` | The panel mounts a canvas terminal (`.oc-terminal-canvas` + `.oc-terminal-input`); typing `touch /tmp/terminal-proof-…` + Enter created that file, and the server had a live `/bin/zsh` child. A session whose folder is gone is refused with "Invalid working directory". |
| Files panel: tree, new file, new folder, upload, refresh, collapse | `PASS` (affordances) | Opening the panel exposes New File, New Folder, Upload files, Refresh and Collapse all folders; Refresh and Collapse all folders were clicked and the panel stayed healthy. Creating files in the user's project was not exercised on purpose. |
| Project knowledge: notes/todo/plans | `PASS` | Opens on "0/3000 — No notes yet. Capture context, reminders, or links." with Notes 0 / Todo 0 / Plans 0 tabs. |
| Browser panel | `PASS` (renders) | Shows an address bar and detected dev servers (localhost:3191/3991/5000/…). |
| Pull Request panel | `BLOCKED` | Needs a branch that can open a PR (GitHub remote). |
| Walkthrough panel | `BLOCKED` | "No small model available" — needs a configured small model. |
| Context panel | `PASS` (renders) | Empty until a session is open; then shows model/effort/context usage. |
| Usage readout + Refresh usage | `PASS` (renders) | "Usage 5-Hour 5%". |
| Configure panels | `PASS` | Opens "Rail panels — Choose which panels the rail shows. Hidden panels keep their data and stay reachable from the command palette." with Context, Git, Pull Request, Changes, Walkthrough, Linear, Files, Terminal, Project knowledge, Plan, Browser, Chat and 24 checkboxes. |

## E. Settings

Every page opens and its items are enumerable by `data-settings-item`. Counts
below are the items each page carries; a page is `PASS` only where a control's
effect was observed (a toggle flipped **and** survived a reload), not merely
because it rendered.

Measured limit of the harness, so the `UNTESTED` rows are read correctly: on a
page whose items are editors rather than toggles (Commands, Snippets, Projects,
Notifications), clicking the `data-settings-item` **row** changes nothing —
dialog count, input count and body text length are identical before and after,
and focus stays on a button. The activator is a control *inside* the item
("sign in", "Add", a select), which differs per item; those pages were therefore
only enumerated, not driven.

| Page | Items | Status | Evidence |
|---|---|---|---|
| General | 13 | `PASS` | `appearance.auto-save-enabled` flipped true→false and stayed false after a reload; `sessions.agent-control-tool` flipped true→false and persisted the same way (restored afterwards). |
| Appearance | 16 | `PASS` (one item) | Theme mode `Dark` set `data-theme="dark"` and persisted; 15 items (`light-theme`, `scrollbars`, `language`, font sizes, density, …) render, undriven. |
| Chat | 33 | `PASS` | `chat.reasoning-traces` toggled on and the transcript then rendered the model's thinking; `chat.streaming-auto-follow` and `chat.activity-default` (a Collapsed/Expanded radio) each flipped and survived a reload (both restored). 31 items undriven. |
| Notifications | 2 | `UNTESTED` | `notifications.delivery` carries no checkbox or switch in its markup, so the probe's toggle pass could not drive it; `notifications.push` undriven. |
| Sessions | 15 | `PASS` (one item) | `sessions.deletion-dialog` flipped true→false and survived a reload (restored). The other 14 (model/thinking/agent/permission/retention/small-model/…) render, undriven. |
| Routing | 4 | `PASS` | `routing.enabled` flipped true→false and survived a reload (restored). |
| Shortcuts | 1 | `UNTESTED` | `shortcuts.keyboard-shortcuts` renders; it opens a shortcut editor rather than a toggle. |
| Voice | 2 | `PASS` (one item) | `voice.playback` flipped false→true and survived a reload (restored); `voice.speech-recognition` needs audio. |
| Integrations | 5 | `UNTESTED` | `integrations.first-party`/`github`/`linear`/`extensions` render; each opens a dialog rather than a toggle. |
| Extensions | 3 | `UNTESTED` | `extensions.add`, `extensions.gitIdentity`, `extensions.updates.check` render; no toggle. |
| Usage | 2 | `PASS` (one item) | `usage.work-status-panel` flipped true→false and survived a reload (restored). |
| Projects | 9 | `UNTESTED` | Items `projects.name`/`default-agent`/`default-model`/`accent-color`/`icon`/`actions` render; they are pickers and dialogs, not toggles. |
| Remote Instances | 1 | `UNTESTED` | `remote-instances.client-auth` renders; needs a remote. |
| External Tunnel (beta) | 1 | `BLOCKED` | Needs a tunnel provider. |
| Git | 4 | `PASS` (one item) | `git.gitmoji` flipped false→true and survived a reload (restored). `git.identities`, `git.changes-view`, `git.gitignored-files` render. |
| Providers | 2 | `PASS` (affordance) | `providers.login` lists ChatGPT Plus/Pro (Codex Subscription) and Anthropic (Claude Pro/Max), both "Not signed in" with a sign-in control; `providers.models` renders. Signing in was not run. |
| Agents | 1 | `UNTESTED` | `agents.create` renders; the page starts at "Total 0 — No agents configured" and the permission editor only appears for an agent that exists (§I.10). |
| Behavior | 2 | `PASS` (one item) | `behavior.response-style` flipped false→true and survived a reload (restored); `behavior.system-prompt` renders. |
| Commands | 1 | `UNTESTED` | `commands.create` renders; no toggle. |
| MCP | 1 | `PARTIAL` | `mcp.create` renders ("Add MCP server — Local command or remote URL"); the list is empty, so enable/disable is unverified. |
| Magic Prompts | 3 | `UNTESTED` | `magic-prompts.reset-overrides`, `magic-prompts.visible-prompt`, `magic-prompts.instructions` render; no toggle. |
| Snippets | 1 | `UNTESTED` | `snippets.create` renders; the `#` picker itself is verified in section A. |
| Skills | 1 | `UNTESTED` | `skills.create` renders. |
| Skills Catalog | 3 | `UNTESTED` | `skills.catalog.search`/`source`/`add-catalog` render; no toggle. |

## F. Desktop shell (Electron) — 65 IPC commands

Driven through the preload bridge (`window.__OPENCHAMBER_DESKTOP__.invoke`) inside
the repackaged app, so these exercise the real main-process handlers.

| Function | Status | Evidence |
|---|---|---|
| App starts; in-process server; UI from `openchamber-ui://app` | `PASS` | Window URL `openchamber-ui://app/index.html`. |
| Bundled `omp` binary runs a turn | `PASS` | Prompt answered inside the packaged window. |
| Prompt round-trip in the packaged window (no duplicate) | `PASS` | `PONG` in 2.5 s, marker rendered once. |
| `desktop_get_app_version` | `PASS` | `0.1.2` — matches the bumped package. |
| Window state / fullscreen read | `PASS` | `{maximized:false}`, `false`. |
| Toggle maximise (both ways) | `PASS` | `{maximized:true}` then `{maximized:false}`. |
| Focus main window | `PASS` | `{focused:true}`. |
| Keep-awake set/get round-trip | `PASS` | `enabled/active` true → false. |
| Launch at login read | `PASS` | `{supported:true, enabled:false}`; setting it was not driven. |
| Minimise to tray | `PASS` (unsupported here) | `{supported:false}` on macOS — expected; the dock owns that role. |
| Window pin | `PASS` (refuses) | Errors with "Pinning is only available for Mini Chat windows" — correct for the main window. |
| LAN address | `PASS` | `172.20.10.2`. |
| Install id | `PASS` | A UUID. |
| Hosts / SSH instances / SSH status | `PASS` (empty) | `{hosts:[]}`, `{instances:[]}`, `[]` — no remotes configured; handlers answer. |
| Read a file | `PASS` | `{mime, base64}` whose payload decodes to the real `package.json`. |
| Installed-app discovery | `FIXED` | Now lists only bundles that exist (Finder, Terminal, VS Code, Sublime Text) with an icon each; §I.7. |
| Filter installed apps | `FIXED` | Drops names that are not bundles (iTerm, made-up names); §I.7. |
| Fetch app icons | `PASS` | Returns a PNG data URL per resolvable app. |
| Capture page rect | `PASS` | Returns a JPEG data URL. |
| Update **check** | `PASS` | `{available:false, currentVersion:"0.1.2"}`; re-driven in the packaged app, it answers `{available:false, currentVersion:"0.1.2", version:null, body:null, date:"2026-10-09T05:48:12.021Z"}` — a real feed round-trip. |
| Native notification | `PARTIAL` | `desktop_notify` returned null with no throw; the banner itself is not observable from the harness. |
| Tray update | `PASS` (accepted) | `desktop_tray_update` returned null; the handler calls `state.trayController.update(args \|\| {})` inside a try/catch that logs a warning, and nothing was logged. It takes a live snapshot, not the payload the probe sends. |
| Window title | `PARTIAL` | The handler is `browserWindow.setTitle(args.title)` and returned null, but `document.title` stayed `phonnt \| OpenAny` — that is the page title, not the window title, so the OS titlebar could not be read: `osascript` on this machine answers "System Events got an error: osascript is not allowed assistive access". |
| Local client token | `PASS` (empty by design) | `desktop_local_client_token_get` answers `""`: UI auth is off on loopback, so nothing mints one. |
| Update **install** (download + restart) | `UNTESTED` | The repo's own e2e fixture is Linux-only (`ARCHITECTURES` maps to `latest-linux.yml` and an AppImage), so a macOS install needs a real older build plus a feed. Not run. |
| Mini-chat window, new window, window drag/minimise/close | `PASS` (windows) | `desktop_open_draft_mini_chat_window` produced a real second page target at `openchamber-ui://app/mini-chat.html?mode=draft`, and `desktop_new_window` a third at `index.html` (CDP listed 3 pages). `desktop_start_window_drag` returned null. Minimise and close were not driven. |
| Deep link `openany://` | `PASS` | `open "openany://session/01a11f8e-45ba-7000-aab9-5be72e69adb1"` routed the running app: its page URL became `openchamber-ui://app/index.html?session=01a11f8e-45ba-7000-aab9-5be72e69adb1`. The scheme is registered in the bundle and `app.on('open-url')` → `handleOpenUrl` reached `handleDeepLinks`. |
| Desktop password, remote password login | `UNTESTED` | `desktop_remote_password_login` validates before anything else — `{}` answers "Invalid URL" — and no remote is configured. The desktop password would change this machine's app auth, so it was not set. |
| App menu, reveal path, open path, open external URL | `PASS` (three of four) | `desktop_show_app_menu`, `desktop_reveal_path` (`/tmp`) and `desktop_open_external_url` (`https://example.com`) each returned null, opening the app menu, a Finder window and a browser tab on this machine. `desktop_open_path` and `desktop_open_in_app` were not driven. |
| Save markdown, pick theme file | `PARTIAL` (validation) | `desktop_save_markdown_file` refuses a call with no name — "Default file name is required" — before touching `dialog.showSaveDialog`; `desktop_pick_theme_file` goes straight to `dialog.showOpenDialog`. Both dialogs are native and app-modal, so they cannot be dismissed from CDP and the write itself was not driven. |
| Browser clear data | `UNTESTED` | It would wipe this machine's app browser data; not run. |
| Read a file outside the workspace | `PASS` (refuses) | `desktop_read_file({path:"/tmp/definitely-not-here-xyz"})` is refused with "File is outside the allowed workspace" — the boundary holds before any filesystem read. |
| Hosts read | `PASS` | `{hosts:[], defaultHostId:"local", initialHostChoiceCompleted:true, localOrigin:"http://127.0.0.1:57123"}`. |
| Scheduled tasks | `PASS` | the toolbar's Scheduled tasks opens "Scheduled tasks — Local — ~ new task — No scheduled tasks yet." |
| Dev tunnel, relay | `BLOCKED` | Needs a tunnel provider/account. |
| SSH connect / logs / import hosts | `BLOCKED` | Needs a remote host; `desktop_hosts_get` reports `{hosts:[]}` and `desktop_ssh_status` an empty list, so the handlers answer. |
| Voice / TTS / dictation | `BLOCKED` | Would speak aloud on this machine; startup log shows 176 macOS voices. |


## G. Packaging and release

| Function | Status | Evidence |
|---|---|---|
| macOS arm64 + Intel dmg/zip + merged manifest | `PASS` | CI produced both arches and a 690-byte merged `latest-mac.yml`. |
| Windows NSIS installer + `latest.yml` | `PASS` (build only) | `windows-2022` job green; manifest size matches the asset. Never run on Windows. |
| Linux AppImage | `BLOCKED` (rule fixed) | The payload check rejected `onnxruntime-node`'s `bin/napi-v3/linux/arm64/…` binding as an x64 mismatch: the rule only knew darwin/win32/windows and the dashed `linux-arm64` form. It now judges a `.node` by any platform or architecture segment that is not the target's (local test 3 pass/2 fail before, 5/5 after). The `openany-v0.1.2` run is re-running with it. |
| Unsigned installer opens on a fresh machine | `FAIL` (by design, distribution caveat) | The packaged bundle is ad-hoc signed — `codesign -dv` reports `flags=0x10002(adhoc,runtime)`, `Signature=adhoc`, `TeamIdentifier=not set`, and `codesign --verify --deep --strict` passes — but **Gatekeeper rejects it**: `spctl -a -t exec -vv OpenAny.app` answers `rejected`. A downloaded copy carries the quarantine flag, so macOS refuses to open it until the user allows it (System Settings → Privacy & Security → "Open Anyway") or clears the attribute. Not a code defect: signing and notarization need an Apple Developer identity. |

## H. Providers, models, MCP

| Function | Status | Evidence |
|---|---|---|
| Model catalog read from the account's credentials | `PASS` | Real catalog returned. |
| Provider sign-in (OAuth) | `PASS` (affordance) | Settings → Providers lists "Provider sign-in — ChatGPT Plus/Pro (Codex Subscription) — Not signed in — sign in" and "Anthropic (Claude Pro/Max) — Not signed in — sign in"; the `login` route + URL/device flow exist. The flow itself was not completed (it needs the user's account). |
| MCP server list / enable / disable | `PARTIAL` | Settings → MCP reads "Tool servers your agents can call. Open one to see its status and settings. — No MCP servers yet. Add MCP server — Local command or remote URL". The list and the add affordance render; nothing exists to enable or disable. |

## J. Plan — the remaining audit (chat nâng cao + 23 Settings pages)

Method per item, so each result is evidence and not an opinion. Every step runs
against the repo server on a spare port (real `omp`) and, where the surface is
native, the repackaged app.

### Chat: turn control
| Item | How it is proven |
|---|---|
| Effort / variant reaches the run | Change the effort in the composer's picker, send one prompt, then read the session file's `thinking_level_change` line for the new level. |
| Fast mode toggle | Toggle it, send a prompt, and read `set_fast_mode`'s answer plus the session file; the picker's own state must survive a reload. |
| Stop a running turn | Send a long prompt, press Stop, and confirm the turn ends (`session.idle`) with the partial answer kept and the composer free. |
| Queue while busy | Send a second prompt while the first runs; the server queue must show it and deliver it on idle, in order. |
| Steer a running turn | With "follow-up" set to steer, send while busy and confirm the text joins the running turn instead of queuing. |

### Chat: content
| Item | How it is proven |
|---|---|
| Image attachment | Attach a real PNG from disk, send, and confirm the prompt body carried base64 (`images`) and the model answered about it. |
| `@` file/agent mention | Type `@`, pick a file from the picker, and confirm the prompt carries that path (the model reads the file). |
| `/` command sent for real | Send a cheap command (`/usage`) and confirm it runs (a command answer, not a model turn on the raw text). |
| `#` snippet picker | Type `#` and confirm the picker lists snippets; insert one and confirm the text lands in the composer. |
| Tool-call parts render | Send a prompt that runs a tool (`read` a file) and confirm a tool part renders with its output. |
| Reasoning traces visible | With "Show Reasoning Traces" on, send a thinking prompt and confirm reasoning text appears in the transcript (§I.3). |

### Chat: sessions
| Item | How it is proven |
|---|---|
| Fork from here | Fork at a user message, confirm a new session appears whose transcript ends at the cut, and that the original is untouched. |
| Start new session from an answer | Use it, confirm a new draft opens carrying the answer as context. |
| Ask other models / multi-run | Confirm the flow opens and, if it sends, that each model answers. |
| BTW composer | Open it, send, confirm the side answer arrives and does not enter the main transcript. |
| Parallel run | Enable it from the picker and confirm the composer switches to multi-model mode. |
| Export a healthy session | Export a session whose folder exists and confirm the markdown file is written (or the download fires). |

### Chat: model interaction
| Item | How it is proven |
|---|---|
| Model `ask` form | Prompt for a question the model must ask, answer the form, and confirm the turn continues with the answer. |
| Permission approve / reject | Prompt for a bash command with permissions on "ask", then approve once and reject once, confirming each outcome. |
| Goals / small-model affordance | Confirm the Goals control says what it needs and that a goal cannot start without a small model — the affordance must not promise a turn it cannot run. |

### Settings — one row per page, one observable effect each
Open the page, list its controls, drive the primary control, and confirm the
effect persists (localStorage / the server's settings file) or visibly changes
the app. Pages that exist only to configure a runtime OMP lacks get flagged as
dead affordances instead of being marked untested:
General, Appearance (done), Chat, Notifications, Sessions, Routing, Shortcuts,
Voice, Integrations, Extensions, Usage, Projects, Remote Instances, External
Tunnel, Git, Providers, Agents, Behavior, Commands, MCP, Magic Prompts,
Snippets, Skills, Skills Catalog.



### I.1 One prompt rendered twice — FIXED
Live stream named the user message by the client id the prompt declared
(`expectUserMessage`); `GET /sessions/:id/messages` named it by its timestamp
(`omp:<session>:user:<ts>`). Every page load/refetch inserted the prompt again
under the other id. Fix: `projectOmpHistory` takes a `userMessageId` resolver and
the host inverts its client-id→timestamp record. Evidence: live id
`client-msg-lgs0o4` = page id `client-msg-lgs0o4`; marker renders once (was 2–3).

### I.2 Picking a model ran the old one — FIXED
`OmpRuntimeClient.sendPrompt` dropped `params.model`, the prompt route had no
model fields, and OMP keeps the model on the session (`set_model`). Fix: the
prompt body carries `provider`/`modelId`; the host applies `set_model` before
prompting and remembers the applied pair. Evidence: badge
`GLM-5.3-Flash · 3.7s` after picking it.

### I.3 No visible progress before the first token — NOT REPRODUCED
The claim: 14 s with no DOM change on a 559-message session while the model
prefilled. Measured on that same session (`01a0ccc4…`, 565 messages, opened via
`?session=`): the transcript renders in **2.5 s**, and a send puts the composer
into "Stop generating" **1.3 s** after Enter, with the transcript changing at the
same moment. On a fresh session the same button appears at 1.1–2.2 s.

The signal is real end to end: `omp --mode rpc` reports `isStreaming: true`
1.1 s after the prompt is accepted (measured with `get_state` polls; the prefill
window ran 1.1 s → 4.0 s), the adapter maps `agent_start` to
`session.status { busy }` (`mapping-events.ts`), and the UI derives both the stop
button (`ChatContainer: sessionIsWorking`) and the floating status row
(`useSessionActivity` → `useAssistantStatus().working.isWorking`) from that same
busy status, so both appear together.

Not measured: whether the *first* send after a cold start of a huge session can
stall while the client hydrates. Nothing in the code suggests it, and the open
path measured clean, so the row is downgraded rather than fixed.

**A real gap remains next to it**: inside the transcript, the latest turn shows
no in-turn working indicator until an activity segment exists
(`MessageList.tsx: isWorking` requires `hasAnchoredActivitySegment`), so during
the prefill window the only visible progress is the composer's stop button and
the floating status chip. That is a design choice, not the reported silence.


### I.4 A session whose folder was deleted failed with a misleading message — FIXED
The server answers `409 { error: "This session's folder no longer exists: …",
code: "session_directory_missing" }`, but the chat said *"the server may be
offline or unreachable"*: `getMessages` threw `OMP request failed: 409`,
discarding the sentence, and the notice never read the error. Fix: the OMP client
raises a typed `AgentRequestError` carrying the route's own sentence (every route
now does, through the shared `readJson` refusal), and the chat notice shows it
when the runtime refused the read. Verified: opening a row whose project folder
was deleted now reads "This session's folder no longer exists: … OMP cannot open
a session whose folder is gone."
Still open from the same root: none — the export path now shows the runtime's
own sentence too.

### I.5 The composer promised a shell prefix it cannot deliver — FIXED
The composer's hint read "`@` for files/agents; `/` for commands and skills;
`!` for shell; `#` for snippets" and carried a shell input mode with its own
placeholder string, while `ChatInput` pins `inputMode` to "normal" — its own
comment: "The runtime has no shell route: every send is a normal prompt." OMP's
RPC has no shell command at all (`abort`, `prompt`, `set_model`,
`set_thinking_level`, `branch`, `new_session`, `switch_session`, `get_state`,
`get_*`, `login`, `set_fast_mode`, `cycle_thinking_level`, `set_session_name`),
so there was nothing to wire. The hint drops the shell clause and the `!` in the
compact variant, and the unreferenced `chat.chatInput.placeholder.shell` string
is removed, in all 13 locales. Verified in the built UI: the composer now reads
"Use @ / # for helpers".

### I.7 "Open in app" offered apps that are not installed — FIXED
`resolveAppBundlePath` fell back to `mdfind -name <name>.app` and accepted the
first hit if the path merely existed. On this machine `mdfind -name iTerm.app`
answers `/usr/share/terminfo/69/iTerm.app` — a **terminfo file** — so iTerm was
reported installed (`desktop_filter_installed_apps(["Finder","iTerm"])` kept it)
and the app list offered an action that could not work. A hit now counts only
when it is a directory named `*.app`, the fixed candidates are checked the same
way, and `INSTALLED_APPS_CACHE_VERSION` is 3 so caches holding the bad name
refresh instead of surviving a day. Verified in the repackaged app: the list is
Finder / Terminal / Visual Studio Code / Sublime Text, each with an icon, and the
filter drops iTerm and made-up names.

### I.8 A slash command answered with nothing — FIXED
OMP runs `/name` inside the session process: its answer arrives as
`{type:"command_output", text:"…"}` plus `{type:"notice", …}`, and the prompt's
response is `{agentInvoked:false}` (no turn, no message). The adapter declared
neither frame, so the projector's `default: []` dropped both — and since no user
message is created either, the optimistic bubble was rolled back: **the thirty
commands the composer offers produced no visible result at all**. Measured
directly against `omp --mode rpc`: `/usage` emits the usage text, `/fast` emits
"Fast mode disabled." with an info notice.

Fix: `command_output` projects to the shell row the vocabulary already has for a
command and its output, naming the command the prompt carried (`expectCommand` on
the projector, set by the host and cleared when a message arrives instead), and
`notice` projects to a system row — or a session error at level `error`. Verified
in the UI: `/usage` renders "Shell Command 0.1s /usage".

### I.9 Fast mode has no control — OPEN (gap vs the plan)
`setFastMode` exists on the client, the `/fast-mode` route and the adapter
(`set_fast_mode`), and the p6 plan put it in the model picker, but **nothing in
the UI calls it**. OMP's own `/fast` command toggles it and its output is now
visible (I.8), so the state is reachable — the picker control is simply absent.

### I.6 Focus mode toggle showed no change — OPEN (unconfirmed)
`Toggle focus mode` was clicked and the composer's width was unchanged (718 px
before and after). Not investigated further; it may change something other than
width.

### I.10 Permissions: the UI writes keys OMP does not read — ONE GAP
The approval gate itself works: with `tools.approvalMode: always-ask` the dock
appears, **Approve** runs the tool, **Deny** leaves it unexecuted, per call. The
gap is that **no UI surface writes that key**, and the one that looks like it
should writes the wrong vocabulary.

**What OMP actually reads** (`@oh-my-pi/pi-coding-agent`,
`src/config/settings-schema.ts`):

- `tools.approvalMode` — `always-ask` | `write` | `yolo`, **default `yolo`**
  (auto-approves every tier; the reason an unprompted bash ran in earlier
  attempts). `always-ask` auto-approves read-only tools and prompts for
  write/exec.
- `tools.approval` — a per-tool record: `allow` / `prompt` / `deny`.

Both live in `config.yml` and are reachable through OMP's own
`omp config set tools.approvalMode …`. **OpenChamber's Settings exposes
neither** — the ~130 settings items enumerated on the Settings pages contain no
approval control.

**What the UI writes instead.** Settings → Agents → Tool Permissions saves
OpenCode-v2 rules (`PATCH /api/config/agents/:name`), which land as
`permissions: [{action, resource, effect}]` plus `mode: primary|subagent` in the
agent's markdown frontmatter. OMP's agent parser
(`src/discovery/helpers.ts: parseAgentFields`) reads `name`, `description`,
`tools`, `spawns`, `output`, `thinkingLevel`/`thinking`, `model`, `blocking`,
`readSummarize`, `prewalk`, `advisor` — **no `permissions`, no `mode`**. Its
`schema`-adjacent reader on OpenChamber's side (`config-entity-routes.js:
readGlobalPermissionRules`) looks for the v1 `tools`/`permission` and v2
`permissions` keys in `config.yml`, which OMP's settings carry none of; the
module's own documentation says `global` is "empty in practice".

**Consequences.** The Tool Permissions editor is a control whose value OMP never
applies to a session, and a custom agent written by that page has no `name` or
`description`, so OMP's parser rejects it as an agent at all. `agentSelection` is
also `false` ("OMP has no session agent to switch") and the prompt body carries
no `agent` field (`omp-routes.js: promptBodySchema`), so the composer cannot pick
a custom agent for a chat either. Anyone who wants the session to ask before a
shell command must set `tools.approvalMode` themselves — the terminal command
`omp config set` is the supported path.

### I.11 The `@` picker was promised and never opened — FIXED
`/` opens the command palette and `#` opens the snippet picker (both verified by
typing them: `/add-dir`, `/advisor`, `/autoresearch`, `/browser`; `+ Add new
snippet`, `#expandx`). `@` opened **nothing** — in a managed chat *and* in a
project session, with a bare `@` and with `@packages/ui/src`.

Cause: the picker is switched off on purpose.
`composer/language/triggers.ts: matchMention()` returns `null` with the reason
"the `@`-mention picker searched the runtime's file index, which OMP does not
expose, so no caret position opens it." The composer's hint still promised it:
"@ for files/agents; / for commands and skills; # for snippets".

Fix: the hint now says "@ to reference a file by path; …" — a mention is still a
plain token OMP resolves (typing one works), but the text no longer promises a
completion list that does not exist. Changed in all 13 dictionaries
(`en`, `de`, `es`, `fr`, `ja`, `ko`, `nl`, `pl`, `pt-BR`, `tr`, `uk`, `zh-CN`,
`zh-TW`); `bun test src/lib/i18n` passes (18 tests) and the rebuilt bundle shows
the new text in the composer.

### I.12 The UI type-check was red — FIXED
`packages/ui` `bun run type-check` reported one error:
`src/lib/agent/omp-runtime.ts(649,5): Type 'string' is not assignable to type
'"primary" | "all" | "subagent"'`. `listAgents` mapped OMP's free-form
`mode: string` straight into the contract's union. An unrecognized mode (the
agent files are hand-written) now reads as `"all"`, the vocabulary's neutral
value — the same value an absent mode already produced.

With that fixed, a second error surfaced: `omp-runtime.test.ts(234,44): Expected
0 arguments, but got 1` — the unsupported stubs declared no parameters while the
contract gives `stageRevert`, `commitRevert`, `clearRevert` and
`getSessionTurnDiff` a session id. The stubs now carry the contract's parameter
lists. `bun run type-check` is clean and `bun test src/lib/agent` passes (64).

### I.13 The form path could not fire for an OMP session — FIXED
The UI carries a whole form surface — `FormDock`, `FormCard`, the contract's
`listPendingForms`/`replyForm`, and the `form.created`/`form.settled` events —
which the server projects from OMP's `extension_ui_request` frames with method
`select` or `editor` (`omp-approvals.js`: "the model asking the user a question
(the `ask` tool)").

Asked to ask a question, the model answered: "No ask tool exists in this
session's toolset (Read, Bash, Edit, Eval, Glob, Grep, Task, Hub, Todo, Web
Search, Write, plus the xd:// devices: security_scan, ast_edit, debug, lsp)."
That was accurate. **OMP asks through the host**, and the `ask` tool is only
created for a session that declares a UI:

- `src/tools/ask.ts`: `static createIf(session) { return (session.canPromptUser
  ?? session.hasUI) ? new AskTool(session) : null }`
- `src/main.ts:2066`: `sessionOptions.hasUI = isInteractive || mode === "rpc-ui"`

The adapter was spawning `omp --mode rpc`, where `hasUI` is false, so the tool
was never created and no `select`/`editor` frame was ever emitted. The other two
host-facing prompts are unaffected — a tool approval is a `confirm` frame and
the OAuth code prompt an `input` frame, both of which arrive under plain `rpc`
(and both were verified working; §B approval dock).

Measured directly:

```
omp --mode rpc     -> tools(11): read, bash, edit, eval, glob, grep, task, hub, todo, web_search, write   has ask? false
omp --mode rpc-ui  -> tools(12): read, bash, edit, ask, eval, glob, grep, task, hub, todo, web_search, write   has ask? true
```

Fix: `rpc-client.ts` and `rpc-host.ts` spawn `--mode rpc-ui`. Verified end to
end in the app: a prompt asking the model to ask a question raised the form dock
with "Red — The color red." / "Blue — The color blue." and `dismiss` / `submit`;
choosing Red and submitting closed the dock and the turn recorded the `ask` call
with that answer. `bun test` in `packages/omp-adapter` (111) and
`packages/web` `server/lib/agents` (91) pass.






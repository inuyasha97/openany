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
| Attach an image | `UNTESTED` | Prompt body carries base64 images; never attached one. |
| Attach a non-image file | `ABSENT` | `attachmentKinds: "images"`; other files are sent by `@path` mention. |
| `@` file/agent mention menu | `UNTESTED` | |
| `/` command or skill | `FIXED` | Typing `/` opens the Command Palette listing OMP's 30 commands; sending one now renders its output ("Shell Command 0.1s /usage"). Before the fix the command produced nothing visible at all; §I.8. |
| `#` snippet | `UNTESTED` | An inline `#` trigger exists in the composer's tokenizer; no picker was observed by the probe. |
| `!` shell prefix | `FIXED` | The composer advertised "`!` for shell" while a leading `!` reaches the model (`!echo shell-check` was answered by `DeepSeek V4 Flash · 3.7s`). OMP has no shell command in its RPC, and `ChatInput` pins `inputMode` to "normal" for that reason. The hint no longer promises a shell (all 13 locales) and the dead `chat.chatInput.placeholder.shell` string is gone; §I.5. |
| Dictation | `BLOCKED` | Needs a microphone/audio device. |
| Focus mode toggle | `UNTESTED` | |
| Permissions mode (`ask every time` → …) | `PASS` | Clicking cycled the control from "Permissions: ask every time" to "Permissions: accept everything". |
| Send while the session is busy (queue) | `UNTESTED` | Server-owned queue for web/desktop. |
| Stop a running turn | `PASS` | The composer renders "Stop generating" while a turn is in flight (seen at 0.7 s and 2.1 s into two turns) and it disappears the moment the turn ends. Clicking it during the model's thinking phase ended the turn with no answer and freed the composer. A mid-answer abort could not be caught: this model finishes a 400-line answer in 5.7 s. |
| Visible progress before the first token | `FAIL` | 14 s with no DOM change on a large-context session while the model prefilled; §I.3. |
| Parallel run ("Run on several models") | `UNTESTED` | Offered by the picker. |
| BTW side composer | `UNTESTED` | |

## B. Chat message actions

| Function | Status | Evidence |
|---|---|---|
| Copy message text | `PASS` | Assistant message's copy put `ONE` on the clipboard. |
| Pin into context (survives compaction) | `PASS` | Pin state set on the message (`aria-pressed`). |
| Continue from this answer → menu | `PASS` | Opens: Fork from here / Start new session from this answer / Ask other models / Start new multi-run. |
| Fork from here | `UNTESTED` | Menu item clicked; the fork dialog's outcome was not confirmed. |
| Start new session from this answer | `UNTESTED` | |
| Ask other models / multi-run from an answer | `UNTESTED` | |
| Revert (undo) a message | `ABSENT` | `revert: false` — OMP keeps no file snapshots. |
| Per-turn file diff | `ABSENT` | `turnDiff: false`. |
| Scroll to bottom | `UNTESTED` | |
| Turn stats / context sources readouts | `PASS` (renders) | Turn stats, tokens, cost and "8 skills" render after a turn. |

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
| Rename | `UNTESTED` | Menu item responds; the inline editor's result was not confirmed. |
| Rename with AI | `UNTESTED` | |
| Pin session | `UNTESTED` | Menu item responds; the row's pin state was not confirmed. |
| Track as in work | `UNTESTED` | |
| Move to folder | `UNTESTED` | |
| Move to worktree | `UNTESTED` | |
| Open in Side Panel (beta) | `UNTESTED` | |
| Delete | `UNTESTED` | Destructive; not run on purpose. |
| Search sessions | `UNTESTED` | |
| Select sessions (bulk) | `UNTESTED` | |
| Display mode: Grouped / Timeline / Manual | `UNTESTED` | Menu lists all three plus sorts and scopes. |
| Display mode: sort (A→Z, Newest, Recent activity) and scope (All/One project) | `UNTESTED` | |
| Show more sessions (pagination) | `UNTESTED` | |
| Project menu: New session / Edit / Close project | `UNTESTED` | |

## D. Panels

| Function | Status | Evidence |
|---|---|---|
| Git panel: status, branch, sync, stashes | `PASS` (renders) | Shows `main`, "Working tree clean", a sync control. Sync itself needs a remote — `UNTESTED`. |
| Changes panel | `PASS` (renders) | "Changed: 0 — working tree clean, no changes to display". |
| Terminal panel | `PASS` | The panel mounts a canvas terminal (`.oc-terminal-canvas` + `.oc-terminal-input`); typing `touch /tmp/terminal-proof-…` + Enter created that file, and the server had a live `/bin/zsh` child. A session whose folder is gone is refused with "Invalid working directory". |
| Files panel: tree, new file, new folder, upload, refresh, collapse | `UNTESTED` | The tree renders (home directory); opening a file was not confirmed — the probe clicked the wrong panel. |
| Project knowledge: notes/todo/plans | `UNTESTED` | "0/3000, no notes yet". |
| Browser panel | `PASS` (renders) | Shows an address bar and detected dev servers (localhost:3191/3991/5000/…). |
| Pull Request panel | `BLOCKED` | Needs a branch that can open a PR (GitHub remote). |
| Walkthrough panel | `BLOCKED` | "No small model available" — needs a configured small model. |
| Context panel | `PASS` (renders) | Empty until a session is open; then shows model/effort/context usage. |
| Usage readout + Refresh usage | `PASS` (renders) | "Usage 5-Hour 5%". |
| Configure panels | `UNTESTED` | |

## E. Settings

Pages exist (verified by the settings nav): General, Appearance, Chat,
Notifications, Sessions, Routing, Shortcuts, Voice, Integrations, Extensions,
Usage, Projects, Remote Instances, External Tunnel (beta), Git, Providers,
Agents, Behavior, Commands, MCP, Magic Prompts, Snippets, Skills, Skills
Catalog.

| Function | Status | Evidence |
|---|---|---|
| Settings window opens, all 24 pages listed | `PASS` | Nav enumerated: General, Appearance, Chat, Notifications, Sessions, Routing, Shortcuts, Voice, Integrations, Extensions, Usage, Projects, Remote Instances, External Tunnel, Git, Providers, Agents, Behavior, Commands, MCP, Magic Prompts, Snippets, Skills, Skills Catalog. |
| Appearance: theme mode (System/Light/Dark) | `PASS` | Choosing `Dark` set `data-theme="dark"` and persisted it (`themeMode=dark`, `selectedThemeVariant=dark`, `useSystemTheme=false`). |
| Appearance: light/dark theme pickers, Reload themes, font sizes, density | `UNTESTED` | Controls render (e.g. "Select light theme", "Reload themes"). |
| Sessions: Session Defaults (Default Model / Thinking / Agent / Permissions) | `UNTESTED` | The page renders: "New sessions will start with: OMP agent default", Default Model "Not selected", Default Thinking "Default", Default Agent "Not selected". Changing a default was not confirmed. |
| Any other settings page's controls change behavior | `UNTESTED` | No other page was driven. |

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
| Update **check** | `PASS` | `{available:false, currentVersion:"0.1.2"}`. |
| Native notification | `PARTIAL` | `desktop_notify` returned null with no throw; the banner itself is not observable from the harness. |
| Tray update | `UNTESTED` | Takes a live snapshot (`useTraySync`), not the payload the probe sent; the handler tolerated it. |
| Window title | `UNTESTED` | `desktop_set_window_title` returned null and the title stayed `phonnt | OpenAny`; the UI may re-set it. |
| Local client token | `UNTESTED` | Empty string — UI auth is off on loopback, so nothing mints one. |
| Update **install** (download + restart) | `UNTESTED` | Never completed one. |
| Mini-chat window, new window, window drag/minimise/close | `UNTESTED` | |
| Deep link `openany://` | `UNTESTED` | Scheme is registered in the bundle. |
| Desktop password, remote password login | `UNTESTED` | |
| App menu, reveal path, open path, open external URL | `UNTESTED` | Would open Finder/browser windows on this machine. |
| Save markdown, pick theme file | `UNTESTED` | Needs a native dialog. |
| Browser clear data | `UNTESTED` | |
| Dev tunnel, relay | `BLOCKED` | Needs a tunnel provider/account. |
| SSH connect / logs / import hosts | `BLOCKED` | Needs a remote host. |
| Voice / TTS / dictation | `BLOCKED` | Would speak aloud on this machine; startup log shows 176 macOS voices. |
| Scheduled tasks | `UNTESTED` | |


## G. Packaging and release

| Function | Status | Evidence |
|---|---|---|
| macOS arm64 + Intel dmg/zip + merged manifest | `PASS` | CI produced both arches and a 690-byte merged `latest-mac.yml`. |
| Windows NSIS installer + `latest.yml` | `PASS` (build only) | `windows-2022` job green; manifest size matches the asset. Never run on Windows. |
| Linux AppImage | `BLOCKED` (rule fixed) | The payload check rejected `onnxruntime-node`'s `bin/napi-v3/linux/arm64/…` binding as an x64 mismatch: the rule only knew darwin/win32/windows and the dashed `linux-arm64` form. It now judges a `.node` by any platform or architecture segment that is not the target's (local test 3 pass/2 fail before, 5/5 after). The `openany-v0.1.2` run is re-running with it. |
| Unsigned installer opens on a fresh machine | `UNTESTED` | SmartScreen/Gatekeeper behaviour unverified. |

## H. Providers, models, MCP

| Function | Status | Evidence |
|---|---|---|
| Model catalog read from the account's credentials | `PASS` | Real catalog returned. |
| Provider sign-in (OAuth) | `UNTESTED` | `login` route + URL/device flow exist. |
| MCP server list / enable / disable | `UNTESTED` | |

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

### I.3 No visible progress before the first token — OPEN (needs a product call)
Measured: 14 s with no DOM change on a 559-message session while the model
prefilled, then the whole answer; 6.4 s to first token on a fresh session.
Streamed reasoning tokens exist but render only inside the collapsed Activity
group (`[data-reasoning]` count 0 during the turn). Options: a "working" row from
the moment the prompt is accepted, or revealing the reasoning stream.

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

---
title: Run OMP and ACP agents
---

## App

### New

- **Agent runtimes:** start a session on OpenCode, OMP, or an ACP agent. Pick the runtime in the composer when you start a session, after switching OMP and ACP on in Settings. Each runtime runs in its own way, and the composer only offers what the chosen one can do.

### Improvements

- Sessions from every runtime show in the same project list and stay there after a reload.

### Fixes

- Chat: a very long error message starts collapsed with a **Show full error** button, instead of turning the chat into a wall of text (thanks to @yulia-ivashko).
- Settings/Routing: thinking levels show their names, not numbers, so an Auto-routed message no longer fails on a saved level (thanks to @yulia-ivashko).
- Dictation: long local dictations finish instead of timing out, and long takes are cut inside real pauses between words (thanks to @Tobias-Conrad and @yulia-ivashko).
- Spaces: plainer wording across the isolated-space screens (thanks to @yulia-ivashko).
- Browser: a restored tab no longer retries its dead dev server at launch.
- Agents: deleted agents stay out of the list, and the Reset that always failed is gone.

### Misc

- Includes the merged OpenChamber release through 2.0.4.

## VS Code

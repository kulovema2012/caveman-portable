# caveman-portable

Makes Claude Code and Codex reply in caveman style: compressed prose with no articles, filler or pleasantries, while code, paths, errors and numbers stay exact. It applies to the main conversation and to every sub-agent, on any device with Node.js. It does not need Orca, memory plugins or any particular IDE.

## Requirements

- Node.js 18 or newer on PATH. The Claude hook runs on it, and so does this installer.
- A current Claude Code release (output styles and SubagentStart hooks with `additionalContext`).
- Codex CLI 0.147 or newer. It reads `~/.agents/skills` natively and has sub-agents on by default.
- Either tool may be missing; its part simply waits until the tool is installed.

## Install

Copy this folder to the device, then run one of:

- Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`
- macOS / Linux: `sh install.sh`
- Anywhere: `node caveman.mjs install`

Add `--dry-run` to preview, or `--only claude` / `--only codex` to limit it to one tool. Afterwards, restart any open Claude Code or Codex sessions and run `node caveman.mjs verify`.

Running install again is safe. It only changes what differs from the payload, and otherwise reports "already up to date".

## What it changes

| Path | Change | Why |
|---|---|---|
| `~/.claude/output-styles/caveman.md` | copied | Claude main conversation and forks |
| `~/.claude/hooks/caveman-subagent.mjs` | copied | Gives every other Claude sub-agent (general-purpose, Explore, Plan, custom) the caveman rules; output styles don't reach them |
| `~/.claude/settings.json` | sets `outputStyle` to `"Caveman"`; adds one SubagentStart hook group (exec form, using this device's node binary); disables `explanatory-output-style` if it is enabled | Merged: every other setting and hook is left alone |
| `~/.agents/skills/caveman/SKILL.md` | copied | Shared skill. Codex reads this folder natively |
| `~/.claude/skills/caveman` | link to the shared skill (a junction on Windows) | Claude doesn't read `~/.agents/skills` |
| `~/.codex/AGENTS.md` | caveman section between `<!-- caveman:start -->` and `<!-- caveman:end -->`, placed at the top when new | Codex main agent and sub-agents. The rest of the file is left alone |
| `~/.codex/config.toml` | `multi_agent = true` under `[features]` | On by default since 0.147; pinned so it stays explicit |
| `~/.codex/skills/caveman` | a separate real copy is moved to the backup | Otherwise Codex would load two caveman skills |

Everything it overwrites or moves goes to `~/.caveman-backups/<timestamp>/` first.

`CLAUDE_CONFIG_DIR` is honoured if set. `CODEX_HOME` deliberately is not: IDEs such as Orca point it at a per-launch runtime home. The setup therefore lives in `~/.codex`, where Codex looks when nothing overrides it. `verify` tells you if the current shell's `CODEX_HOME` does not link back to it.

## Why these layers

- The **output style** covers Claude's main conversation and forks.
- The **SubagentStart hook** covers every other Claude sub-agent. Those run their own system prompt, which output styles never reach.
- **`AGENTS.md`** is loaded by every Codex agent, the main one and each spawned sub-agent.
- The **skill** tells the main agent to also put a caveman protocol block into each sub-agent prompt. This is a second layer; the first three work without it.

All of it was tested with Orca's environment removed and with every memory mechanism off (Claude auto-memory, the `remember` and `context-mode` plugins, and Codex `memories`). The main agents and sub-agents in both tools still replied in caveman.

## Verify

`node caveman.mjs verify` checks every piece and runs the hook once. Add `--live` to also run one real Codex prompt and one real Claude Code prompt that each spawn a sub-agent. This uses a few requests on your subscriptions, and you judge the replies by eye.

## Keep the bundle current

`payload/` is a snapshot. After changing the style, hook, skill or AGENTS section on a configured device, run `node caveman.mjs export` there. It copies the live files back into `payload/`; then carry the updated folder to your other devices. `verify` warns when a device has drifted from the payload.

## Uninstall

`node caveman.mjs uninstall` removes the output style, the hook, the settings entries, the skill link and the AGENTS section, with backups. It leaves `multi_agent` alone (Codex's default anyway) and does not re-enable the explanatory plugin.

## Known overwrite risks

- `npx skills update` can replace `~/.agents/skills/caveman` with an upstream version if the skills CLI tracks it in `~/.agents/.skill-lock.json`. Re-run install afterwards.
- context-mode upgrades may regenerate `~/.codex/AGENTS.md`. Re-running install restores only the caveman section, thanks to the markers.

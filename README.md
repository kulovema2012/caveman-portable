# caveman-portable

Makes Claude Code and Codex reply in caveman style: compressed prose with no articles, filler or pleasantries, while code, paths, errors and numbers stay exact. It applies to the main conversation and to every sub-agent, on any device with Node.js. It does not need an IDE, memory plugins or a GitHub login.

```
npx -y caveman-portable
```

That single line sets up a device on Windows, macOS or Linux. Restart any open Claude Code or Codex sessions afterwards.

## Requirements

- Node.js 18 or newer on PATH. The Claude hook runs on it, and so does this installer.
- A current Claude Code release (output styles and SubagentStart hooks with `additionalContext`).
- Codex CLI 0.147 or newer. It reads `~/.agents/skills` natively and has sub-agents on by default.
- Either tool may be missing; its part simply waits until the tool is installed.

## Install

### One line

- From npm: `npx -y caveman-portable`
- From GitHub: `npx -y github:kulovema2012/caveman-portable`

With no command it runs `install`. Flags and commands still work after it, for example `npx -y caveman-portable --dry-run` or `npx -y caveman-portable verify`. npx runs the installer from its cache, and the installer copies everything into your home folder, so nothing depends on the cache afterwards.

To pin an exact release on a machine you care about, add the version: `npx -y caveman-portable@1.0.0`.

### From a clone

```
git clone https://github.com/kulovema2012/caveman-portable.git
cd caveman-portable
node caveman.mjs install
```

`install.ps1` (Windows) and `install.sh` (macOS / Linux) are thin wrappers that check for Node.js first.

Add `--dry-run` to preview, or `--only claude` / `--only codex` to limit it to one tool. Running install again is safe. It only changes what differs from the payload, and otherwise reports "already up to date".

## What it changes

| Path | Change | Why |
|---|---|---|
| `~/.claude/output-styles/caveman.md` | copied | Claude main conversation and forks |
| `~/.claude/hooks/caveman-subagent.mjs` | copied | Gives every other Claude sub-agent (general-purpose, Explore, Plan, custom) the caveman rules; output styles don't reach them |
| `~/.claude/settings.json` | sets `outputStyle` to `"Caveman"`; adds one SubagentStart hook group (exec form, using this device's node binary); disables `explanatory-output-style` if it is enabled | Merged: every other setting and hook is left alone |
| `~/.agents/skills/caveman/SKILL.md` | copied | Shared skill. Codex reads this folder natively |
| `~/.claude/skills/caveman` | link to the shared skill (a junction on Windows) | Claude doesn't read `~/.agents/skills` |
| `~/.agents/.skill-lock.json` | removes only its `caveman` entry, if present | Otherwise `npx skills update` could put an upstream caveman back over this one |
| `~/.codex/AGENTS.md` | caveman section between `<!-- caveman:start -->` and `<!-- caveman:end -->`, placed at the top when new | Codex main agent and sub-agents. The rest of the file is left alone |
| `~/.codex/config.toml` | `multi_agent = true` under `[features]` | On by default since 0.147; pinned so it stays explicit |
| `~/.codex/skills/caveman` | a separate real copy is moved to the backup | Otherwise Codex would load two caveman skills |

Everything it overwrites or moves goes to `~/.caveman-backups/<timestamp>/` first.

`CLAUDE_CONFIG_DIR` is honoured if set. `CODEX_HOME` deliberately is not: some IDEs point it at a per-launch runtime home. The setup therefore lives in `~/.codex`, where Codex looks when nothing overrides it. `verify` tells you if the current shell's `CODEX_HOME` does not link back to it.

## Why these layers

- The **output style** covers Claude's main conversation and forks.
- The **SubagentStart hook** covers every other Claude sub-agent. Those run their own system prompt, which output styles never reach.
- **`AGENTS.md`** is loaded by every Codex agent, the main one and each spawned sub-agent.
- The **skill** tells the main agent to also put a caveman protocol block into each sub-agent prompt. This is a second layer; the first three work without it.

All of it was tested with no IDE environment and with every memory mechanism off (Claude auto-memory, the `remember` and `context-mode` plugins, and Codex `memories`). The main agents and sub-agents in both tools still replied in caveman.

## If a caveman skill is already installed

| Existing caveman | What happens |
|---|---|
| Real copy in `~/.claude/skills/caveman` or `~/.codex/skills/caveman` | Moved to the backup and replaced by the shared skill |
| Installed by `npx skills` (for example from `mattpocock/skills`) | Overwritten, with the original in the backup, and dropped from the skills lock file so an update can't revert it |
| A link to somewhere else | Re-pointed to the shared skill; the old target is not touched |
| In a project's `.claude/skills/` | Claude Code runs the personal skill over a project skill with the same name, so this one wins |
| Shipped by a plugin (`/plugin:caveman`) | Both load, because plugin skills are namespaced. `verify` warns so you can disable the plugin if its rules conflict |
| Enterprise-managed skill | The enterprise skill wins. The output style, hook and `AGENTS.md` still apply |

## Verify

`node caveman.mjs verify` (or `npx -y caveman-portable verify`) checks every piece, runs the hook once, and warns about neighbouring caveman skills. Add `--live` to also run one real Codex prompt and one real Claude Code prompt that each spawn a sub-agent. This uses a few requests on your subscriptions, and you judge the replies by eye.

## Changing the style

`payload/` is what gets installed. After changing the style, hook, skill or AGENTS section on a configured device, run `node caveman.mjs export` in a clone. It copies the live files back into `payload/`; commit the change, then re-run the installer on your other devices.

## Uninstall

`node caveman.mjs uninstall` (or `npx -y caveman-portable uninstall`) removes the output style, the hook, the settings entries, the skill link and the AGENTS section, with backups. It leaves `multi_agent` alone (Codex's default anyway), does not re-enable the explanatory plugin, and does not restore the skills lock entry.

## Known overwrite risks

- Tools that rewrite `~/.codex/AGENTS.md` (context-mode upgrades, for example) can drop the section. Re-running install restores only the caveman section, thanks to the markers.
- A plugin or IDE that re-adds its own caveman skill can show up again. `verify` flags it.

## Credits

The caveman idea and its first skill come from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). This package rewrites the skill for both Claude Code and Codex and adds the output style, the sub-agent hook and the installer.

## License

MIT. See [LICENSE](LICENSE).

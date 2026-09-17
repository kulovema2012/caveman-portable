#!/usr/bin/env node
// caveman-portable: makes Claude Code and Codex reply in caveman style, main agent and sub-agents alike.
//
//   node caveman.mjs install   [--dry-run] [--only claude|codex] [--icon display|plugin|none] [--no-codex-notice] [--home DIR]
//   node caveman.mjs verify    [--only claude|codex] [--home DIR] [--live]
//   node caveman.mjs uninstall [--dry-run] [--only claude|codex] [--home DIR]
//   node caveman.mjs export    refresh payload/ from this device's live files
//
// Nothing here depends on Orca, memory plugins or any IDE. Every piece lands in the tools' default config
// locations, and the tools load it themselves at session start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BUNDLE = path.dirname(fileURLToPath(import.meta.url));
const PAYLOAD = path.join(BUNDLE, 'payload');
const argv = process.argv.slice(2);
// No command means install, so the one-liner `npx -y caveman-portable` sets a device up directly.
const command = argv[0] === undefined || argv[0].startsWith('--') ? 'install' : argv[0];
const hasFlag = (name) => argv.includes(name);
const optionValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const DRY = hasFlag('--dry-run');
const ONLY = optionValue('--only');
// The status-line badge is the default way to show the style in Claude; the inline reply icon is opt-in.
// Codex has no customisable status line, so its per-prompt notice stays the default there.
const ICON = optionValue('--icon') ?? 'none';
const STATUSLINE = optionValue('--statusline') ?? 'patch';
const CODEX_NOTICE_WANTED = !hasFlag('--no-codex-notice');
const HOME_OVERRIDE = optionValue('--home');
const HOME = path.resolve(HOME_OVERRIDE ?? os.homedir());
// Claude Code honours CLAUDE_CONFIG_DIR. CODEX_HOME is ignored on purpose: IDEs such as Orca point it at a
// per-launch runtime home, and this setup has to live where Codex looks when nothing overrides it.
const CLAUDE_DIR =
  !HOME_OVERRIDE && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude');
const CODEX_DIR = path.join(HOME, '.codex');
const SHARED_SKILL_DIR = path.join(HOME, '.agents', 'skills', 'caveman');
const BACKUP_DIR = path.join(HOME, '.caveman-backups', new Date().toISOString().replace(/[:.]/g, '-'));

const SUBAGENT_HOOK = 'caveman-subagent.mjs';
const DISPLAY_HOOK = 'caveman-display.mjs';
const CODEX_NOTICE = 'caveman-notice.mjs';
const STATUSLINE_SCRIPT = 'caveman-statusline.mjs';
const EXPLANATORY_PLUGIN = 'explanatory-output-style@claude-plugins-official';
const MARK_START = '<!-- caveman:start (managed by caveman-portable; edit payload/codex/AGENTS.caveman.md) -->';
const MARK_END = '<!-- caveman:end -->';
const LEGACY_HEADING = '# Response style — caveman';

// The optional function-hook badge: a local marketplace holding one plugin, so Claude Code can load it
// without a per-launch --plugin-dir flag.
const PLUGIN_ROOT = path.join(HOME, '.caveman-badge');
const MARKETPLACE = 'caveman';
const PLUGIN_ID = `caveman-badge@${MARKETPLACE}`;
const FUNCTION_HOOKS_ENV = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS';
const PLUGIN_PARTS = ['caveman-badge/.claude-plugin/plugin.json', 'caveman-badge/hooks/hooks.json', 'caveman-badge/hooks/badge.js'];

// [payload copy, installed location]
const FILES = {
  style: [path.join(PAYLOAD, 'claude/output-styles/caveman.md'), path.join(CLAUDE_DIR, 'output-styles/caveman.md')],
  subagent: [path.join(PAYLOAD, 'claude/hooks', SUBAGENT_HOOK), path.join(CLAUDE_DIR, 'hooks', SUBAGENT_HOOK)],
  display: [path.join(PAYLOAD, 'claude/hooks', DISPLAY_HOOK), path.join(CLAUDE_DIR, 'hooks', DISPLAY_HOOK)],
  notice: [path.join(PAYLOAD, 'codex/hooks', CODEX_NOTICE), path.join(CODEX_DIR, 'hooks', CODEX_NOTICE)],
  statusline: [path.join(PAYLOAD, 'claude/hooks', STATUSLINE_SCRIPT), path.join(CLAUDE_DIR, 'hooks', STATUSLINE_SCRIPT)],
  skill: [path.join(PAYLOAD, 'agents/skills/caveman/SKILL.md'), path.join(SHARED_SKILL_DIR, 'SKILL.md')],
};
// Holds whatever status-line command was configured before, so uninstall can put it back.
const STATUSLINE_SIDECAR = path.join(CLAUDE_DIR, 'hooks', 'caveman-statusline.json');
const AGENTS_SECTION = path.join(PAYLOAD, 'codex/AGENTS.caveman.md');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_SKILL_LINK = path.join(CLAUDE_DIR, 'skills/caveman');
const CODEX_SKILL_COPY = path.join(CODEX_DIR, 'skills/caveman');
const CODEX_HOOKS = path.join(CODEX_DIR, 'hooks.json');
const AGENTS_MD = path.join(CODEX_DIR, 'AGENTS.md');
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');

const forClaude = ONLY !== 'codex';
const forCodex = ONLY !== 'claude';
const actions = [];
const results = [];
const followUps = [];
let backedUp = false;

// ---------- file helpers ----------

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const slash = (p) => p.replace(/\\/g, '/');
const note = (msg) => actions.push(msg);

function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function realpath(p) {
  try {
    const r = fs.realpathSync.native(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  } catch {
    return null;
  }
}

function backupPath(p) {
  const rel = path.relative(HOME, p);
  return path.join(BACKUP_DIR, rel.startsWith('..') || path.isAbsolute(rel) ? path.basename(p) : rel);
}

function backupCopy(p) {
  if (!fs.existsSync(p) || isLink(p)) return;
  const dest = backupPath(p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(p, dest);
  backedUp = true;
}

function writeText(p, content, why) {
  if (read(p) === content) return;
  note(`${fs.existsSync(p) ? 'update' : 'create'} ${p}${why ? `  (${why})` : ''}`);
  if (DRY) return;
  backupCopy(p);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function deleteFile(p, why) {
  if (!fs.existsSync(p)) return;
  note(`remove ${p}${why ? `  (${why})` : ''}`);
  if (DRY) return;
  backupCopy(p);
  fs.rmSync(p);
}

function moveToBackup(p, why) {
  note(`move ${p} to backup  (${why})`);
  if (DRY) return;
  const dest = backupPath(p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(p, dest);
  backedUp = true;
}

// Removes a symlink or junction itself. Never recursive, so the folder it points at is untouched.
function removeLink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

// Runs one hook script the way its host would, and returns the parsed JSON it printed.
function runHook(cmd, args, input) {
  const run = spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 10000 });
  try {
    return { ok: true, json: JSON.parse(run.stdout) };
  } catch {
    return { ok: false, detail: String(run.error?.message ?? run.stderr ?? run.stdout ?? 'unexpected output').trim() };
  }
}

// ---------- Codex AGENTS.md section ----------

function locateSection(text) {
  const marked = text.indexOf('<!-- caveman:start');
  if (marked !== -1) {
    const end = text.indexOf(MARK_END, marked);
    if (end !== -1) return { start: marked, end: end + MARK_END.length, marked: true };
  }
  // Unmarked section written by hand before this tool existed: runs until the next top-level heading.
  let start = text.startsWith(LEGACY_HEADING) ? 0 : text.indexOf('\n' + LEGACY_HEADING);
  if (start === -1) return null;
  if (start > 0) start += 1;
  const next = text.indexOf('\n# ', start + 1);
  return { start, end: next === -1 ? text.length : next + 1, marked: false };
}

function sectionBody(text, loc) {
  let body = text.slice(loc.start, loc.end);
  if (loc.marked) body = body.slice(body.indexOf('\n') + 1, body.lastIndexOf(MARK_END));
  return body.trim() + '\n';
}

function joinBlocks(...blocks) {
  const kept = blocks.map((b) => b.trim()).filter(Boolean);
  return kept.length ? kept.join('\n\n') + '\n' : '';
}

function ensureAgentsSection() {
  const block = `${MARK_START}\n${read(AGENTS_SECTION).trim()}\n${MARK_END}`;
  const text = read(AGENTS_MD) ?? '';
  const loc = locateSection(text);
  const next = loc ? joinBlocks(text.slice(0, loc.start), block, text.slice(loc.end)) : joinBlocks(block, text);
  const why = !loc ? 'add caveman section at the top' : loc.marked ? 'refresh caveman section' : 'mark caveman section as managed';
  writeText(AGENTS_MD, next, why);
}

function removeAgentsSection() {
  const text = read(AGENTS_MD);
  const loc = text && locateSection(text);
  if (!loc) return;
  const rest = joinBlocks(text.slice(0, loc.start), text.slice(loc.end));
  if (rest) writeText(AGENTS_MD, rest, 'remove caveman section');
  else deleteFile(AGENTS_MD, 'it only held the caveman section');
}

// ---------- Codex config.toml ----------

function withMultiAgent(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) => /^\s*\[features\]\s*(#.*)?$/.test(l));
  if (header === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length) lines.push('');
    lines.push('[features]', 'multi_agent = true', '');
    return lines.join(eol);
  }
  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end++;
  for (let i = header + 1; i < end; i++) {
    if (/^\s*multi_agent\s*=/.test(lines[i])) {
      if (/^\s*multi_agent\s*=\s*true\b/.test(lines[i])) return text;
      lines[i] = 'multi_agent = true';
      return lines.join(eol);
    }
  }
  let at = end;
  while (at - 1 > header && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, 'multi_agent = true');
  return lines.join(eol);
}

// ---------- Codex hooks.json (the per-prompt notice) ----------

const mentionsNotice = (hook) => String(hook?.command ?? '').includes(CODEX_NOTICE);

function loadCodexHooks() {
  const raw = read(CODEX_HOOKS);
  if (raw === null) return { raw, data: {} };
  try {
    return { raw, data: JSON.parse(raw) };
  } catch (e) {
    throw new Error(`${CODEX_HOOKS} is not valid JSON (${e.message}). Fix it first; nothing was changed.`);
  }
}

function ensureCodexNotice() {
  writeText(FILES.notice[1], read(FILES.notice[0]), 'Codex prompt notice: shows the icon each turn');
  const { data } = loadCodexHooks();
  const before = actions.length;
  // Codex runs these through a shell, so the path is quoted rather than passed as argv.
  const entry = { type: 'command', command: `node "${slash(FILES.notice[1])}"`, timeout: 5 };
  data.hooks ??= {};
  data.hooks.UserPromptSubmit ??= [];
  const current = data.hooks.UserPromptSubmit.flatMap((g) => g.hooks ?? []).find(mentionsNotice);
  if (!current) {
    note('codex hooks.json: add caveman UserPromptSubmit notice');
    data.hooks.UserPromptSubmit.push({ hooks: [entry] });
  } else if (current.command !== entry.command) {
    note("codex hooks.json: point the caveman notice at this device's path");
    Object.assign(current, entry);
  }
  if (actions.length !== before) {
    writeText(CODEX_HOOKS, JSON.stringify(data, null, 2) + '\n');
    followUps.push('Codex runs a new hook only after you approve it: open `codex`, review the hook it reports, and trust it.');
  }
}

function removeCodexNotice() {
  const { raw, data } = loadCodexHooks();
  if (raw !== null) {
    const groups = data.hooks?.UserPromptSubmit;
    if (Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some(mentionsNotice))) {
      note('codex hooks.json: remove caveman UserPromptSubmit notice');
      const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !mentionsNotice(h)) })).filter((g) => g.hooks.length);
      if (kept.length) data.hooks.UserPromptSubmit = kept;
      else delete data.hooks.UserPromptSubmit;
      if (!Object.keys(data.hooks).length) delete data.hooks;
      if (Object.keys(data).length) writeText(CODEX_HOOKS, JSON.stringify(data, null, 2) + '\n');
      else deleteFile(CODEX_HOOKS, 'it only held the caveman notice');
    }
  }
  deleteFile(FILES.notice[1], 'Codex prompt notice');
}

// ---------- Claude settings.json ----------

const hookUses = (hook, file) => [hook?.command, ...(hook?.args ?? [])].some((x) => typeof x === 'string' && x.includes(file));

function loadSettings() {
  const raw = read(SETTINGS);
  if (raw === null) return { raw, data: {} };
  try {
    return { raw, data: JSON.parse(raw) };
  } catch (e) {
    throw new Error(`${SETTINGS} is not valid JSON (${e.message}). Fix it first; nothing was changed.`);
  }
}

function saveSettings(data, actionsBefore) {
  if (actions.length === actionsBefore) return;
  // After an uninstall the file can end up holding nothing; leave no empty shell behind.
  if (!Object.keys(data).length) deleteFile(SETTINGS, 'it only held the caveman settings');
  else writeText(SETTINGS, JSON.stringify(data, null, 2) + '\n');
}

// Exec form with this device's node binary: no shell, no PATH lookup at hook time.
const execHook = (script) => ({ type: 'command', command: slash(process.execPath), args: [slash(script)], timeout: 10 });

function ensureHookGroup(data, event, script, label) {
  data.hooks ??= {};
  data.hooks[event] ??= [];
  const wanted = execHook(script);
  const current = data.hooks[event].flatMap((g) => g.hooks ?? []).find((h) => hookUses(h, path.basename(script)));
  if (!current) {
    note(`settings.json: add caveman ${event} hook (${label})`);
    data.hooks[event].unshift({ hooks: [wanted] });
  } else if (current.command !== wanted.command || JSON.stringify(current.args) !== JSON.stringify(wanted.args)) {
    note(`settings.json: point the caveman ${event} hook at this device's node and home`);
    Object.assign(current, wanted);
  }
}

function dropHookGroup(data, event, file) {
  const groups = data.hooks?.[event];
  if (!Array.isArray(groups) || !groups.some((g) => (g.hooks ?? []).some((h) => hookUses(h, file)))) return;
  note(`settings.json: remove caveman ${event} hook`);
  const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !hookUses(h, file)) })).filter((g) => g.hooks.length);
  if (kept.length) data.hooks[event] = kept;
  else delete data.hooks[event];
  if (data.hooks && !Object.keys(data.hooks).length) delete data.hooks;
}

function mergeSettings() {
  const { data } = loadSettings();
  const before = actions.length;
  if (data.outputStyle !== 'Caveman') {
    note(`settings.json: outputStyle ${JSON.stringify(data.outputStyle ?? null)} -> "Caveman"`);
    data.outputStyle = 'Caveman';
  }
  ensureHookGroup(data, 'SubagentStart', FILES.subagent[1], 'rules for every sub-agent');
  if (ICON === 'display') ensureHookGroup(data, 'MessageDisplay', FILES.display[1], 'icon in front of each reply');
  else dropHookGroup(data, 'MessageDisplay', DISPLAY_HOOK);
  if (ICON === 'plugin') enablePluginInSettings(data);
  else disablePluginInSettings(data);
  if (STATUSLINE === 'patch') patchStatusline(data);
  else unpatchStatusline(data);
  if (data.enabledPlugins?.[EXPLANATORY_PLUGIN] === true) {
    note(`settings.json: disable ${EXPLANATORY_PLUGIN} (its Insight blocks fight caveman)`);
    data.enabledPlugins[EXPLANATORY_PLUGIN] = false;
  }
  saveSettings(data, before);
}

function unmergeSettings() {
  const { raw, data } = loadSettings();
  if (raw === null) return;
  const before = actions.length;
  if (data.outputStyle === 'Caveman') {
    note('settings.json: remove outputStyle "Caveman"');
    delete data.outputStyle;
  }
  dropHookGroup(data, 'SubagentStart', SUBAGENT_HOOK);
  dropHookGroup(data, 'MessageDisplay', DISPLAY_HOOK);
  disablePluginInSettings(data);
  unpatchStatusline(data);
  saveSettings(data, before);
}

// ---------- status-line badge ----------
//
// Status-line scripts are personal, so `patch` never edits yours: it saves your command in a sidecar file and
// points the status line at a wrapper that runs it and prefixes the badge. `print` writes a snippet instead,
// for people who would rather edit their own script.

const wrapperCommand = () => `node "${slash(FILES.statusline[1])}"`;

const STATUSLINE_SNIPPET = [
  '  // caveman badge: the status line receives output_style.name, so this re-checks on every refresh.',
  "  const style = (d.output_style && d.output_style.name) || 'default';",
  "  const badge = style.toLowerCase() === 'caveman' ? '\\u{1FAA8} caveman' : '\\u26A0 style: ' + style;",
  '  // then print `badge` alongside whatever else your status line shows.',
].join('\n');

function savedStatusline() {
  try {
    return JSON.parse(read(STATUSLINE_SIDECAR) ?? '{}')?.command ?? null;
  } catch {
    return null;
  }
}

function patchStatusline(data) {
  const wrapper = wrapperCommand();
  const current = data.statusLine;
  if (current?.command === wrapper) return;
  if (current?.type === 'command' && typeof current.command === 'string' && current.command) {
    writeText(STATUSLINE_SIDECAR, JSON.stringify({ command: current.command }, null, 2) + '\n', 'your status line, restored on uninstall');
    note('settings.json: wrap the status line so it also shows the caveman badge');
  } else {
    note('settings.json: set a status line that shows the caveman badge');
  }
  data.statusLine = { ...(current ?? {}), type: 'command', command: wrapper };
}

// Status-line wrappers chain: another tool may have saved a pointer to this wrapper as *its* inner command.
// Removing this one would leave that pointer dangling and silently drop everything beneath it, so hand each
// sibling the command this wrapper was itself running. No tool needs to know any other tool exists.
function repairSiblingWrappers() {
  let inner = null;
  try {
    inner = JSON.parse(read(STATUSLINE_SIDECAR) ?? '{}')?.command ?? null;
  } catch {
    inner = null;
  }
  const dir = path.join(CLAUDE_DIR, 'hooks');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    if (file === STATUSLINE_SIDECAR) continue;
    let data;
    try {
      data = JSON.parse(read(file) ?? 'null');
    } catch {
      continue;
    }
    if (!data || typeof data.command !== 'string' || !data.command.includes(STATUSLINE_SCRIPT)) continue;
    writeText(file, JSON.stringify(inner ? { ...data, command: inner } : {}, null, 2) + '\n', 'another status-line wrapper pointed here; it now runs what this one wrapped');
  }
}

function unpatchStatusline(data) {
  if (data.statusLine?.command !== wrapperCommand()) return;
  const saved = savedStatusline();
  if (saved) {
    note('settings.json: restore your own status line command');
    data.statusLine = { ...data.statusLine, command: saved };
  } else {
    note('settings.json: remove the caveman status line');
    delete data.statusLine;
  }
}

// ---------- the optional function-hook badge plugin ----------

function marketplaceManifest() {
  return (
    JSON.stringify(
      {
        name: MARKETPLACE,
        owner: { name: 'caveman-portable' },
        plugins: [
          {
            name: 'caveman-badge',
            source: './caveman-badge',
            description: 'Draws the caveman icon on each assistant message through a function hook.',
          },
        ],
      },
      null,
      2,
    ) + '\n'
  );
}

function enablePluginInSettings(data) {
  const source = { source: 'directory', path: slash(PLUGIN_ROOT) };
  data.extraKnownMarketplaces ??= {};
  if (JSON.stringify(data.extraKnownMarketplaces[MARKETPLACE]?.source) !== JSON.stringify(source)) {
    note(`settings.json: register the local "${MARKETPLACE}" marketplace`);
    data.extraKnownMarketplaces[MARKETPLACE] = { source };
  }
  data.enabledPlugins ??= {};
  if (data.enabledPlugins[PLUGIN_ID] !== true) {
    note(`settings.json: enable ${PLUGIN_ID}`);
    data.enabledPlugins[PLUGIN_ID] = true;
  }
  data.env ??= {};
  if (data.env[FUNCTION_HOOKS_ENV] !== '1') {
    note(`settings.json: set ${FUNCTION_HOOKS_ENV}=1 (function hooks are off by default)`);
    data.env[FUNCTION_HOOKS_ENV] = '1';
  }
}

function disablePluginInSettings(data) {
  if (data.extraKnownMarketplaces?.[MARKETPLACE]) {
    note(`settings.json: unregister the local "${MARKETPLACE}" marketplace`);
    delete data.extraKnownMarketplaces[MARKETPLACE];
    if (!Object.keys(data.extraKnownMarketplaces).length) delete data.extraKnownMarketplaces;
  }
  if (data.enabledPlugins?.[PLUGIN_ID] !== undefined) {
    note(`settings.json: drop ${PLUGIN_ID}`);
    delete data.enabledPlugins[PLUGIN_ID];
    if (!Object.keys(data.enabledPlugins).length) delete data.enabledPlugins;
  }
  if (data.env?.[FUNCTION_HOOKS_ENV] !== undefined) {
    note(`settings.json: drop ${FUNCTION_HOOKS_ENV}`);
    delete data.env[FUNCTION_HOOKS_ENV];
    if (!Object.keys(data.env).length) delete data.env;
  }
}

function installPluginFiles() {
  for (const rel of PLUGIN_PARTS) writeText(path.join(PLUGIN_ROOT, rel), read(path.join(PAYLOAD, 'plugin', rel)), 'function-hook badge');
  writeText(path.join(PLUGIN_ROOT, '.claude-plugin/marketplace.json'), marketplaceManifest(), 'local marketplace holding the badge');
  followUps.push('The badge plugin uses an experimental flag; if a reply ever shows two icons, one of the two mechanisms is still active.');
}

function removePluginFiles() {
  for (const rel of [...PLUGIN_PARTS, '.claude-plugin/marketplace.json']) deleteFile(path.join(PLUGIN_ROOT, rel), 'function-hook badge');
  if (DRY) return;
  // Remove the folders the plugin owned, deepest first, and only while they are empty.
  for (const rel of ['caveman-badge/hooks', 'caveman-badge/.claude-plugin', 'caveman-badge', '.claude-plugin', '']) {
    try {
      fs.rmdirSync(path.join(PLUGIN_ROOT, rel));
    } catch {
      // not empty or already gone
    }
  }
}

// ---------- skill links ----------

function ensureClaudeSkillLink() {
  if (exists(CLAUDE_SKILL_LINK)) {
    if (isLink(CLAUDE_SKILL_LINK)) {
      if (realpath(CLAUDE_SKILL_LINK) === realpath(SHARED_SKILL_DIR)) return;
      note(`relink ${CLAUDE_SKILL_LINK} -> ${SHARED_SKILL_DIR}`);
      if (!DRY) removeLink(CLAUDE_SKILL_LINK);
    } else {
      moveToBackup(CLAUDE_SKILL_LINK, 'real copy replaced by a link to the shared skill');
    }
  } else {
    note(`link ${CLAUDE_SKILL_LINK} -> ${SHARED_SKILL_DIR}`);
  }
  if (DRY) return;
  fs.mkdirSync(path.dirname(CLAUDE_SKILL_LINK), { recursive: true });
  fs.symlinkSync(SHARED_SKILL_DIR, CLAUDE_SKILL_LINK, process.platform === 'win32' ? 'junction' : 'dir');
}

// ---------- project scope ----------
//
// A project install keeps everything inside one repository: the style, the hooks and a copy of the skill live
// under <project>/.claude, and Codex reads the caveman section from the project's own AGENTS.md. Nothing in the
// home directory is touched, so other projects keep whatever style they had.

const SCOPE = optionValue('--scope') ?? 'user';
const PROJECT_DIR = path.resolve(optionValue('--project') ?? process.cwd());
const PROJECT_CLAUDE = path.join(PROJECT_DIR, '.claude');
// settings.local.json is the personal, git-ignored file; --shared writes the committed settings.json instead.
const PROJECT_SETTINGS = path.join(PROJECT_CLAUDE, hasFlag('--shared') ? 'settings.json' : 'settings.local.json');
const PROJECT_AGENTS = path.join(PROJECT_DIR, 'AGENTS.md');
const PROJECT_FILES = {
  style: [FILES.style[0], path.join(PROJECT_CLAUDE, 'output-styles/caveman.md')],
  subagent: [FILES.subagent[0], path.join(PROJECT_CLAUDE, 'hooks', SUBAGENT_HOOK)],
  display: [FILES.display[0], path.join(PROJECT_CLAUDE, 'hooks', DISPLAY_HOOK)],
  skill: [FILES.skill[0], path.join(PROJECT_CLAUDE, 'skills/caveman/SKILL.md')],
};

// Project hooks address their scripts through ${CLAUDE_PROJECT_DIR}, so the settings file survives a different
// checkout path or machine. Exec form substitutes the placeholder without a shell, so it needs no quoting.
const projectHook = (file) => ({ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/.claude/hooks/${file}`], timeout: 10 });

function requireProjectPayload() {
  const needed = [PROJECT_FILES.style[0], PROJECT_FILES.subagent[0], PROJECT_FILES.skill[0], AGENTS_SECTION];
  if (ICON === 'display') needed.push(PROJECT_FILES.display[0]);
  const missing = needed.filter((p) => !fs.existsSync(p));
  if (missing.length) throw new Error(`payload incomplete, missing:\n  ${missing.join('\n  ')}`);
}

function readProjectSettings() {
  const raw = read(PROJECT_SETTINGS);
  if (raw === null) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${PROJECT_SETTINGS} is not valid JSON (${e.message}). Fix it first; nothing was changed.`);
  }
}

function ensureProjectHook(data, event, file, label) {
  data.hooks ??= {};
  data.hooks[event] ??= [];
  const wanted = projectHook(file);
  const current = data.hooks[event].flatMap((g) => g.hooks ?? []).find((h) => hookUses(h, file));
  if (!current) {
    note(`${path.basename(PROJECT_SETTINGS)}: add caveman ${event} hook (${label})`);
    data.hooks[event].unshift({ hooks: [wanted] });
  } else if (JSON.stringify(current.args) !== JSON.stringify(wanted.args)) {
    note(`${path.basename(PROJECT_SETTINGS)}: repoint the caveman ${event} hook`);
    Object.assign(current, wanted);
  }
}

function ensureProjectAgentsSection() {
  const block = `${MARK_START}\n${read(AGENTS_SECTION).trim()}\n${MARK_END}`;
  const text = read(PROJECT_AGENTS) ?? '';
  const loc = locateSection(text);
  const next = loc ? joinBlocks(text.slice(0, loc.start), block, text.slice(loc.end)) : joinBlocks(block, text);
  writeText(PROJECT_AGENTS, next, 'caveman section in the project AGENTS.md, where Codex reads it');
}

function installProject() {
  requireProjectPayload();
  const data = readProjectSettings();
  const before = actions.length;
  if (forClaude) {
    writeText(PROJECT_FILES.style[1], read(PROJECT_FILES.style[0]), 'output style for this project');
    writeText(PROJECT_FILES.skill[1], read(PROJECT_FILES.skill[0]), 'project copy of the caveman skill');
    writeText(PROJECT_FILES.subagent[1], read(PROJECT_FILES.subagent[0]), 'SubagentStart hook for this project');
    if (data.outputStyle !== 'Caveman') {
      note(`${path.basename(PROJECT_SETTINGS)}: outputStyle ${JSON.stringify(data.outputStyle ?? null)} -> "Caveman"`);
      data.outputStyle = 'Caveman';
    }
    ensureProjectHook(data, 'SubagentStart', SUBAGENT_HOOK, 'rules for every sub-agent');
    if (ICON === 'display') {
      writeText(PROJECT_FILES.display[1], read(PROJECT_FILES.display[0]), 'MessageDisplay hook: icon per reply');
      ensureProjectHook(data, 'MessageDisplay', DISPLAY_HOOK, 'icon in front of each reply');
    } else {
      deleteFile(PROJECT_FILES.display[1], 'icon hook not selected');
      dropHookGroup(data, 'MessageDisplay', DISPLAY_HOOK);
    }
    if (actions.length !== before) writeText(PROJECT_SETTINGS, JSON.stringify(data, null, 2) + '\n');
    if (read(path.join(HOME, '.agents', 'skills', 'caveman', 'SKILL.md')) !== null) {
      followUps.push('A caveman skill also exists in your home directory, and a personal skill wins over a project one with the same name.');
    }
  }
  if (forCodex) ensureProjectAgentsSection();
  followUps.push(`Everything landed inside ${PROJECT_DIR}; no file in your home directory changed.`);
  if (!hasFlag('--shared')) followUps.push(`${path.basename(PROJECT_SETTINGS)} is the personal file — add it to .gitignore if the repo does not ignore it already.`);
}

function uninstallProject() {
  if (forClaude) {
    const data = readProjectSettings();
    const before = actions.length;
    if (data.outputStyle === 'Caveman') {
      note(`${path.basename(PROJECT_SETTINGS)}: remove outputStyle "Caveman"`);
      delete data.outputStyle;
    }
    dropHookGroup(data, 'SubagentStart', SUBAGENT_HOOK);
    dropHookGroup(data, 'MessageDisplay', DISPLAY_HOOK);
    if (actions.length !== before) {
      if (Object.keys(data).length) writeText(PROJECT_SETTINGS, JSON.stringify(data, null, 2) + '\n');
      else deleteFile(PROJECT_SETTINGS, 'it only held the caveman settings');
    }
    for (const key of ['style', 'subagent', 'display', 'skill']) deleteFile(PROJECT_FILES[key][1], 'project caveman file');
    if (!DRY) {
      for (const rel of ['skills/caveman', 'skills', 'hooks', 'output-styles', '']) {
        try {
          fs.rmdirSync(path.join(PROJECT_CLAUDE, rel));
        } catch {
          // still holds other project files; leave it
        }
      }
    }
  }
  if (forCodex) {
    const text = read(PROJECT_AGENTS);
    const loc = text && locateSection(text);
    if (loc) {
      const rest = joinBlocks(text.slice(0, loc.start), text.slice(loc.end));
      if (rest) writeText(PROJECT_AGENTS, rest, 'remove caveman section');
      else deleteFile(PROJECT_AGENTS, 'it only held the caveman section');
    }
  }
}

function verifyProject() {
  requireProjectPayload();
  let data;
  try {
    data = readProjectSettings();
  } catch (e) {
    check('FAIL', 'project settings', e.message);
    data = {};
  }
  if (forClaude) {
    compareToPayload('project output style file', PROJECT_FILES.style);
    compareToPayload('project caveman skill', PROJECT_FILES.skill);
    compareToPayload('project SubagentStart hook script', PROJECT_FILES.subagent);
    check(data.outputStyle === 'Caveman' ? 'ok' : 'FAIL', 'outputStyle is "Caveman"', `${PROJECT_SETTINGS}: ${JSON.stringify(data.outputStyle ?? null)}`);
    for (const [event, file, script] of [
      ['SubagentStart', SUBAGENT_HOOK, PROJECT_FILES.subagent[1]],
      ['MessageDisplay', DISPLAY_HOOK, PROJECT_FILES.display[1]],
    ]) {
      const registered = (data.hooks?.[event] ?? []).flatMap((g) => g.hooks ?? []).some((h) => hookUses(h, file));
      if (!registered) {
        check(event === 'MessageDisplay' ? 'ok' : 'FAIL', `${event} hook registered`, event === 'MessageDisplay' ? 'icon not selected for this project' : 'missing');
        continue;
      }
      const input = event === 'SubagentStart' ? '{"hook_event_name":"SubagentStart"}' : JSON.stringify({ index: 0, delta: 'x', cwd: PROJECT_DIR });
      const r = runHook(process.execPath, [script], input);
      const out = r.ok ? r.json.hookSpecificOutput : null;
      const good = event === 'SubagentStart' ? /caveman/i.test(out?.additionalContext ?? '') : String(out?.displayContent ?? '').includes('\u{1FAA8}');
      check(good ? 'ok' : 'FAIL', `${event} hook runs from the project`, good ? script : r.detail ?? 'unexpected output');
    }
    const personal = read(path.join(HOME, '.agents', 'skills', 'caveman', 'SKILL.md'));
    check(personal === null ? 'ok' : 'warn', 'no personal caveman skill shadowing this one', personal === null ? '' : 'a personal skill wins over a project skill of the same name');
  }
  if (forCodex) {
    const text = read(PROJECT_AGENTS);
    const loc = text && locateSection(text);
    const same = loc && sectionBody(text, loc) === read(AGENTS_SECTION).trim() + '\n';
    check(loc && same ? 'ok' : loc ? 'warn' : 'FAIL', 'project AGENTS.md caveman section', loc ? (same ? PROJECT_AGENTS : 'differs from payload') : `missing in ${PROJECT_AGENTS}`);
    check('ok', 'Codex prompt notice', 'skipped: Codex hooks are per home directory, not per project');
  }
  const width = Math.max(...results.map((r) => r.label.length));
  for (const r of results) console.log(`${`[${r.level}]`.padEnd(7)} ${r.label.padEnd(width)}  ${r.detail}`);
  const fails = results.filter((r) => r.level === 'FAIL').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n${fails ? `${fails} check(s) failed` : 'all required checks passed'}${warns ? `, ${warns} warning(s)` : ''}.`);
  return fails ? 1 : 0;
}

// ---------- commands ----------

function requirePayload() {
  const needed = [FILES.style[0], FILES.subagent[0], FILES.skill[0], AGENTS_SECTION];
  if (ICON === 'display') needed.push(FILES.display[0]);
  if (STATUSLINE === 'patch') needed.push(FILES.statusline[0]);
  if (ICON === 'plugin') needed.push(...PLUGIN_PARTS.map((rel) => path.join(PAYLOAD, 'plugin', rel)));
  if (CODEX_NOTICE_WANTED) needed.push(FILES.notice[0]);
  const missing = needed.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    throw new Error(
      `payload incomplete, missing:\n  ${missing.join('\n  ')}\nRun "node caveman.mjs export" on a device that already has the setup.`,
    );
  }
}

// The `npx skills` CLI records what it installed. If it still tracks caveman, `npx skills update` can quietly put
// the upstream version back over this one. Dropping just that entry stops it; the skill folder stays.
function dropSkillLockEntry() {
  const lockPath = path.join(HOME, '.agents', '.skill-lock.json');
  const raw = read(lockPath);
  if (raw === null) return;
  let lock;
  try {
    lock = JSON.parse(raw);
  } catch {
    console.warn(`note: ${lockPath} is not valid JSON; left as is`);
    return;
  }
  if (!lock?.skills?.caveman) return;
  delete lock.skills.caveman;
  writeText(lockPath, JSON.stringify(lock, null, 2) + '\n', 'stop `npx skills update` from reverting the caveman skill');
}

function install() {
  requirePayload();
  writeText(FILES.skill[1], read(FILES.skill[0]), 'shared skill: Claude via link, Codex natively');
  dropSkillLockEntry();
  if (forClaude) {
    writeText(FILES.style[1], read(FILES.style[0]), 'output style: main conversation and forks');
    writeText(FILES.subagent[1], read(FILES.subagent[0]), 'SubagentStart hook: every other sub-agent');
    if (ICON === 'display') writeText(FILES.display[1], read(FILES.display[0]), 'MessageDisplay hook: icon per reply');
    else deleteFile(FILES.display[1], 'icon hook not selected');
    if (ICON === 'plugin') installPluginFiles();
    else removePluginFiles();
    if (STATUSLINE === 'patch') writeText(FILES.statusline[1], read(FILES.statusline[0]), 'status-line wrapper: badge beside your own status line');
    ensureClaudeSkillLink();
    mergeSettings();
    // mergeSettings restores the saved command first, so the wrapper and its sidecar go afterwards.
    if (STATUSLINE !== 'patch') {
      repairSiblingWrappers();
      deleteFile(FILES.statusline[1], 'status-line wrapper not selected');
      deleteFile(STATUSLINE_SIDECAR, 'saved status line no longer needed');
    }
    if (STATUSLINE === 'print') followUps.push(`Add the caveman badge to your own status line:\n${STATUSLINE_SNIPPET}`);
  }
  if (forCodex) {
    ensureAgentsSection();
    writeText(CODEX_CONFIG, withMultiAgent(read(CODEX_CONFIG) ?? ''), 'multi_agent: on by default since 0.147, pinned');
    if (CODEX_NOTICE_WANTED) ensureCodexNotice();
    else removeCodexNotice();
    if (exists(CODEX_SKILL_COPY) && !isLink(CODEX_SKILL_COPY)) {
      moveToBackup(CODEX_SKILL_COPY, 'Codex already reads the shared copy; two copies would both load');
    }
  }
}

function uninstall() {
  if (forClaude) {
    unmergeSettings();
    if (isLink(CLAUDE_SKILL_LINK) && realpath(CLAUDE_SKILL_LINK) === realpath(SHARED_SKILL_DIR)) {
      note(`unlink ${CLAUDE_SKILL_LINK}`);
      if (!DRY) removeLink(CLAUDE_SKILL_LINK);
    }
    deleteFile(FILES.style[1], 'caveman output style');
    deleteFile(FILES.subagent[1], 'caveman SubagentStart hook');
    deleteFile(FILES.display[1], 'caveman MessageDisplay hook');
    // unmergeSettings already put the saved command back, so these two can go now.
    repairSiblingWrappers();
    deleteFile(FILES.statusline[1], 'caveman status-line wrapper');
    deleteFile(STATUSLINE_SIDECAR, 'saved status line');
    removePluginFiles();
  }
  if (forCodex) {
    removeAgentsSection();
    removeCodexNotice();
  }
  // The shared skill serves both tools, so it only goes on a full uninstall, and only if it is still ours.
  if (forClaude && forCodex && read(FILES.skill[1]) !== null && read(FILES.skill[1]) === read(FILES.skill[0])) {
    deleteFile(FILES.skill[1], 'shared caveman skill');
    if (!DRY) {
      try {
        fs.rmdirSync(SHARED_SKILL_DIR);
      } catch {
        // folder still holds other files; leave it
      }
    }
  }
}

function exportPayload() {
  for (const key of ['style', 'subagent', 'display', 'statusline', 'skill', 'notice']) {
    const [payloadCopy, installed] = FILES[key];
    const live = read(installed);
    if (live === null) {
      console.warn(`note: ${installed} is missing on this device; kept the payload copy`);
      continue;
    }
    writeText(payloadCopy, live, 'from this device');
  }
  const text = read(AGENTS_MD);
  const loc = text && locateSection(text);
  if (!loc) throw new Error(`cannot export: no caveman section in ${AGENTS_MD}`);
  writeText(AGENTS_SECTION, sectionBody(text, loc), 'from this device');
}

// ---------- verify ----------

const check = (level, label, detail = '') => results.push({ level, label, detail });

function compareToPayload(label, [payloadCopy, installed]) {
  const live = read(installed);
  if (live === null) return check('FAIL', label, `missing ${installed}`);
  if (live !== read(payloadCopy)) {
    return check('warn', label, `${installed} differs from payload ("export" refreshes the bundle, "install" overwrites the device)`);
  }
  check('ok', label, installed);
}

function verifyClaude() {
  compareToPayload('Claude output style file', FILES.style);
  compareToPayload('Claude SubagentStart hook script', FILES.subagent);
  let data;
  try {
    data = loadSettings().data;
  } catch (e) {
    return check('FAIL', 'Claude settings.json', e.message);
  }
  check(data.outputStyle === 'Caveman' ? 'ok' : 'FAIL', 'outputStyle is "Caveman"', `found ${JSON.stringify(data.outputStyle ?? null)}`);

  const subagent = (data.hooks?.SubagentStart ?? []).flatMap((g) => g.hooks ?? []).find((h) => hookUses(h, SUBAGENT_HOOK));
  if (!subagent) {
    check('FAIL', 'SubagentStart hook registered', `not found in ${SETTINGS}`);
  } else {
    const r = runHook(subagent.command, subagent.args ?? [], '{"hook_event_name":"SubagentStart"}');
    const out = r.ok ? r.json.hookSpecificOutput : null;
    const good = out?.hookEventName === 'SubagentStart' && /caveman/i.test(out?.additionalContext ?? '');
    check(good ? 'ok' : 'FAIL', 'SubagentStart hook returns caveman rules', good ? `${subagent.command} ${(subagent.args ?? []).join(' ')}` : r.detail ?? 'unexpected output');
  }

  const display = (data.hooks?.MessageDisplay ?? []).flatMap((g) => g.hooks ?? []).find((h) => hookUses(h, DISPLAY_HOOK));
  if (display) {
    compareToPayload('Claude MessageDisplay hook script', FILES.display);
    const r = runHook(display.command, display.args ?? [], JSON.stringify({ index: 0, delta: 'x', cwd: HOME }));
    const drawn = r.ok ? r.json.hookSpecificOutput?.displayContent : null;
    const good = typeof drawn === 'string' && drawn.includes('\u{1FAA8}');
    check(good ? 'ok' : 'FAIL', 'reply icon hook draws the badge', good ? drawn.trim() : r.detail ?? 'no displayContent');
  } else {
    check('ok', 'reply icon hook', 'not installed (status line still shows the style)');
  }

  if (data.enabledPlugins?.[PLUGIN_ID] === true) {
    const files = PLUGIN_PARTS.every((rel) => fs.existsSync(path.join(PLUGIN_ROOT, rel)));
    const flag = data.env?.[FUNCTION_HOOKS_ENV] === '1';
    const market = Boolean(data.extraKnownMarketplaces?.[MARKETPLACE]);
    const missing = [!files && 'plugin files', !flag && `${FUNCTION_HOOKS_ENV}=1`, !market && 'marketplace entry'].filter(Boolean);
    check(missing.length ? 'FAIL' : 'ok', 'function-hook badge plugin', missing.length ? `missing ${missing.join(', ')}` : PLUGIN_ROOT);
  }

  if (data.statusLine?.command === wrapperCommand()) {
    compareToPayload('status-line wrapper script', FILES.statusline);
    const run = spawnSync(process.execPath, [FILES.statusline[1]], {
      input: JSON.stringify({ cwd: HOME, model: { display_name: 'verify' } }),
      encoding: 'utf8',
      timeout: 10000,
    });
    const shown = (run.stdout ?? '').trim();
    check(shown.includes('\u{1FAA8}') ? 'ok' : 'FAIL', 'status line draws the caveman badge', shown || String(run.error?.message ?? 'no output'));
    const saved = savedStatusline();
    check(saved ? 'ok' : 'warn', 'your own status line is saved for uninstall', saved ?? 'none saved: uninstall will just drop the caveman status line');
  } else {
    check('ok', 'status-line badge', 'not installed');
  }

  check(data.enabledPlugins?.[EXPLANATORY_PLUGIN] === true ? 'FAIL' : 'ok', 'explanatory-output-style plugin not enabled');
  const linked = realpath(CLAUDE_SKILL_LINK) !== null && realpath(CLAUDE_SKILL_LINK) === realpath(SHARED_SKILL_DIR);
  check(linked ? 'ok' : 'warn', 'Claude sees the shared caveman skill', linked ? CLAUDE_SKILL_LINK : `${CLAUDE_SKILL_LINK} is not a link to ${SHARED_SKILL_DIR}`);
}

function verifyCodex() {
  const text = read(AGENTS_MD);
  const loc = text && locateSection(text);
  if (!loc) {
    check('FAIL', 'Codex AGENTS.md caveman section', `missing in ${AGENTS_MD}`);
  } else {
    const same = sectionBody(text, loc) === read(AGENTS_SECTION).trim() + '\n';
    const detail = !loc.marked ? 'present but unmarked (run install to mark it as managed)' : same ? AGENTS_MD : 'differs from payload';
    check(loc.marked && same ? 'ok' : 'warn', 'Codex AGENTS.md caveman section', detail);
  }
  const cfg = read(CODEX_CONFIG) ?? '';
  check(
    /^\s*multi_agent\s*=\s*false\b/m.test(cfg) ? 'FAIL' : 'ok',
    'Codex sub-agents (multi_agent) not disabled',
    /^\s*multi_agent\s*=\s*true\b/m.test(cfg) ? 'pinned true' : 'default (on since 0.147)',
  );

  let codexHooks = {};
  try {
    codexHooks = loadCodexHooks().data;
  } catch (e) {
    check('FAIL', 'Codex hooks.json', e.message);
  }
  const notice = (codexHooks.hooks?.UserPromptSubmit ?? []).flatMap((g) => g.hooks ?? []).find(mentionsNotice);
  if (notice) {
    compareToPayload('Codex notice hook script', FILES.notice);
    const r = runHook(process.execPath, [FILES.notice[1]], JSON.stringify({ turn_id: `verify-${process.pid}`, cwd: HOME }));
    const good = r.ok && typeof r.json.systemMessage === 'string' && r.json.systemMessage.includes('\u{1FAA8}');
    check(good ? 'ok' : 'FAIL', 'Codex notice hook prints the icon', good ? r.json.systemMessage : r.detail ?? 'no systemMessage');
    const trusted = (read(path.join(CODEX_DIR, 'config.toml')) ?? '').includes('user_prompt_submit');
    check(trusted ? 'ok' : 'warn', 'Codex has approved a prompt hook', trusted ? 'trust entries present in config.toml' : 'open `codex` once and trust the new hook, or it never runs');
  } else {
    check('ok', 'Codex prompt notice', 'not installed');
  }

  const copy = exists(CODEX_SKILL_COPY) && !isLink(CODEX_SKILL_COPY);
  check(copy ? 'warn' : 'ok', 'no duplicate caveman skill in ~/.codex/skills', copy ? `${CODEX_SKILL_COPY} is a separate copy; Codex would load two` : '');
  const override = process.env.CODEX_HOME;
  if (!HOME_OVERRIDE && override && realpath(override) !== realpath(CODEX_DIR)) {
    const linked = realpath(path.join(override, 'AGENTS.md')) === realpath(AGENTS_MD);
    const detail = linked
      ? `${override} links AGENTS.md back to ~/.codex`
      : `${override}/AGENTS.md does not point at ${AGENTS_MD}; Codex started from this shell will not see caveman`;
    check(linked ? 'ok' : 'warn', 'this shell sets CODEX_HOME (e.g. an IDE)', detail);
  }
}

function liveTests() {
  const env = { ...process.env };
  delete env.CLAUDECODE; // lets the check run from inside a Claude Code session
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const task = 'Explain in three or four sentences why a detached HEAD happens in git and how to get back to a branch.';
  const prompt = (tool) =>
    `Use ${tool} to spawn exactly one sub-agent. Pass it only this task, with no extra instructions: '${task}' ` +
    'Wait for it. Then output its report exactly as returned under the heading SUBAGENT REPORT, then one line of your own under the heading MAIN.';
  const quote = (a) => (/[\s']/.test(a) ? `"${a}"` : a);
  const lastMessage = path.join(os.tmpdir(), `caveman-live-${process.pid}.txt`);
  const runs = [];
  if (forCodex) runs.push(['Codex', ['codex', 'exec', '--skip-git-repo-check', '-s', 'read-only', '-o', lastMessage, prompt('your sub-agent tool')], lastMessage]);
  if (forClaude) runs.push(['Claude Code', ['claude', '-p', prompt('the Agent tool')], null]);
  for (const [name, cmd, outFile] of runs) {
    console.log(`\n=== live test: ${name}. Judge by eye: both sections should read caveman ===`);
    const r = spawnSync(cmd.map(quote).join(' '), { env, cwd: os.tmpdir(), shell: true, encoding: 'utf8', timeout: 300000 });
    const text = outFile ? read(outFile) : r.stdout;
    console.log(r.status === 0 && text ? text.trim() : `failed (exit ${r.status}): ${String(r.stderr || r.error?.message || '').trim().slice(-800)}`);
    if (outFile) fs.rmSync(outFile, { force: true });
  }
}

// Plugin skills are namespaced (/plugin:caveman), so a plugin's caveman loads next to this one rather than
// replacing it. Cache layout for both tools: <cache>/<marketplace>/<plugin>/<version>/skills/<skill>/SKILL.md
function pluginsWithCavemanSkill(cacheRoot) {
  const subdirs = (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  const found = new Set();
  for (const market of subdirs(cacheRoot)) {
    for (const plugin of subdirs(path.join(cacheRoot, market))) {
      for (const version of subdirs(path.join(cacheRoot, market, plugin))) {
        if (fs.existsSync(path.join(cacheRoot, market, plugin, version, 'skills', 'caveman', 'SKILL.md'))) {
          found.add(`${plugin}@${market}`);
        }
      }
    }
  }
  return [...found];
}

function verifyNeighbours() {
  let tracked = false;
  try {
    tracked = Boolean(JSON.parse(read(path.join(HOME, '.agents', '.skill-lock.json')) ?? '{}')?.skills?.caveman);
  } catch {
    // unreadable lock file: nothing to warn about
  }
  check(
    tracked ? 'warn' : 'ok',
    'npx-skills lock does not track caveman',
    tracked ? '`npx skills update` could revert the skill; run install to drop the entry' : '',
  );
  if (forClaude) {
    let enabled = {};
    try {
      enabled = loadSettings().data.enabledPlugins ?? {};
    } catch {
      // settings.json problems are reported by verifyClaude
    }
    const active = pluginsWithCavemanSkill(path.join(CLAUDE_DIR, 'plugins', 'cache')).filter((id) => enabled[id] === true);
    check(
      active.length ? 'warn' : 'ok',
      'no enabled Claude plugin ships its own caveman skill',
      active.length ? `${active.join(', ')} also loads a caveman skill; disable it if its rules conflict` : '',
    );
  }
  if (forCodex) {
    const installed = pluginsWithCavemanSkill(path.join(CODEX_DIR, 'plugins', 'cache'));
    check(
      installed.length ? 'warn' : 'ok',
      'no Codex plugin ships its own caveman skill',
      installed.length ? `${installed.join(', ')} includes a caveman skill; disable it in config.toml if its rules conflict` : '',
    );
  }
}

function verify() {
  requirePayload();
  compareToPayload('shared caveman skill', FILES.skill);
  verifyNeighbours();
  if (forClaude) verifyClaude();
  if (forCodex) verifyCodex();
  const width = Math.max(...results.map((r) => r.label.length));
  for (const r of results) console.log(`${`[${r.level}]`.padEnd(7)} ${r.label.padEnd(width)}  ${r.detail}`);
  const fails = results.filter((r) => r.level === 'FAIL').length;
  const warns = results.filter((r) => r.level === 'warn').length;
  console.log(`\n${fails ? `${fails} check(s) failed` : 'all required checks passed'}${warns ? `, ${warns} warning(s)` : ''}.`);
  if (hasFlag('--live')) liveTests();
  return fails ? 1 : 0;
}

// ---------- main ----------

const USAGE = [
  'usage: node caveman.mjs [install|verify|uninstall|export|help] [options]',
  '',
  '  no command          install (so `npx -y caveman-portable` sets up a device in one line)',
  '  --scope user        default: install for every project on this machine',
  '  --scope project     install inside one repository only, nothing in the home directory',
  '  --project DIR       which repository (default: the current directory)',
  '  --shared            project scope: write .claude/settings.json (committed) instead of settings.local.json',
  '  --statusline patch  default: wrap your status line so it also shows the caveman badge',
  '  --statusline print  print a snippet to add to your own status-line script instead',
  '  --statusline none   leave the status line alone',
  '  --icon display      also draw the icon in front of each reply (a MessageDisplay hook)',
  '  --icon plugin       user scope only: the experimental function-hook badge instead',
  '  --icon none         default: no inline icon',
  '  --no-codex-notice   skip the per-prompt notice in Codex',
  '  --only claude|codex limit the install to one tool',
  '  --dry-run           show what would change',
  '  --home DIR          treat DIR as the home directory (testing)',
  '  --live              verify only: also run one real Claude and Codex prompt',
].join('\n');

try {
  if (ONLY && !['claude', 'codex'].includes(ONLY)) throw new Error('--only must be "claude" or "codex"');
  if (!['display', 'plugin', 'none'].includes(ICON)) throw new Error('--icon must be "display", "plugin" or "none"');
  if (!['patch', 'print', 'none'].includes(STATUSLINE)) throw new Error('--statusline must be "patch", "print" or "none"');
  if (!['user', 'project'].includes(SCOPE)) throw new Error('--scope must be "user" or "project"');
  const project = SCOPE === 'project';
  if (project && ICON === 'plugin') throw new Error('--icon plugin is user scope only: a plugin loads from the home directory, not from a project');
  if (project && command === 'export') throw new Error('export refreshes the payload from a user-scope install; run it without --scope project');
  if (['install', 'uninstall', 'export'].includes(command)) {
    if (command === 'install') project ? installProject() : install();
    else if (command === 'uninstall') project ? uninstallProject() : uninstall();
    else exportPayload();
    if (!actions.length) {
      console.log(command === 'export' ? 'payload already matches this device.' : 'already up to date; nothing to change.');
    } else {
      console.log(`${DRY ? 'Dry run, would make' : 'Made'} ${actions.length} change(s):`);
      for (const a of actions) console.log(`  - ${a}`);
    }
    if (backedUp) console.log(`Backups: ${BACKUP_DIR}`);
    if (command !== 'export' && actions.length && !DRY) {
      const next = command === 'install' ? ', then run: node caveman.mjs verify' : '.';
      console.log(`Restart open Claude Code / Codex sessions to load the change${next}`);
      for (const line of followUps) console.log(`  ! ${line}`);
    }
    if (command === 'uninstall' && actions.length) {
      console.log(`Not touched: Codex multi_agent (its default anyway) and ${EXPLANATORY_PLUGIN}; re-enable that plugin yourself if you want it.`);
    }
  } else if (command === 'verify') {
    process.exitCode = project ? verifyProject() : verify();
  } else {
    console.log(USAGE);
    process.exitCode = command === 'help' ? 0 : 1;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}

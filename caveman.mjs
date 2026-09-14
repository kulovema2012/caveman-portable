#!/usr/bin/env node
// caveman-portable: makes Claude Code and Codex reply in caveman style, main agent and sub-agents alike.
//
//   node caveman.mjs install   [--dry-run] [--only claude|codex] [--home DIR]
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
const HOME_OVERRIDE = optionValue('--home');
const HOME = path.resolve(HOME_OVERRIDE ?? os.homedir());
// Claude Code honours CLAUDE_CONFIG_DIR. CODEX_HOME is ignored on purpose: IDEs such as Orca point it at a
// per-launch runtime home, and this setup has to live where Codex looks when nothing overrides it.
const CLAUDE_DIR =
  !HOME_OVERRIDE && process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude');
const CODEX_DIR = path.join(HOME, '.codex');
const SHARED_SKILL_DIR = path.join(HOME, '.agents', 'skills', 'caveman');
const BACKUP_DIR = path.join(HOME, '.caveman-backups', new Date().toISOString().replace(/[:.]/g, '-'));

const HOOK_NAME = 'caveman-subagent.mjs';
const EXPLANATORY_PLUGIN = 'explanatory-output-style@claude-plugins-official';
const MARK_START = '<!-- caveman:start (managed by caveman-portable; edit payload/codex/AGENTS.caveman.md) -->';
const MARK_END = '<!-- caveman:end -->';
const LEGACY_HEADING = '# Response style — caveman';

// [payload copy, installed location]
const FILES = {
  style: [path.join(PAYLOAD, 'claude/output-styles/caveman.md'), path.join(CLAUDE_DIR, 'output-styles/caveman.md')],
  hook: [path.join(PAYLOAD, 'claude/hooks', HOOK_NAME), path.join(CLAUDE_DIR, 'hooks', HOOK_NAME)],
  skill: [path.join(PAYLOAD, 'agents/skills/caveman/SKILL.md'), path.join(SHARED_SKILL_DIR, 'SKILL.md')],
};
const AGENTS_SECTION = path.join(PAYLOAD, 'codex/AGENTS.caveman.md');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_SKILL_LINK = path.join(CLAUDE_DIR, 'skills/caveman');
const CODEX_SKILL_COPY = path.join(CODEX_DIR, 'skills/caveman');
const AGENTS_MD = path.join(CODEX_DIR, 'AGENTS.md');
const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');

const forClaude = ONLY !== 'codex';
const forCodex = ONLY !== 'claude';
const actions = [];
const results = [];
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

// ---------- Claude settings.json ----------

const isCavemanHook = (h) => [h?.command, ...(h?.args ?? [])].some((x) => typeof x === 'string' && x.includes(HOOK_NAME));

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
  writeText(SETTINGS, JSON.stringify(data, null, 2) + '\n');
}

function mergeSettings() {
  const { data } = loadSettings();
  const before = actions.length;
  if (data.outputStyle !== 'Caveman') {
    note(`settings.json: outputStyle ${JSON.stringify(data.outputStyle ?? null)} -> "Caveman"`);
    data.outputStyle = 'Caveman';
  }
  // Exec form with this device's node binary: no shell, no PATH lookup at hook time.
  const hook = { type: 'command', command: slash(process.execPath), args: [slash(FILES.hook[1])], timeout: 10 };
  data.hooks ??= {};
  data.hooks.SubagentStart ??= [];
  const current = data.hooks.SubagentStart.flatMap((g) => g.hooks ?? []).find(isCavemanHook);
  if (!current) {
    note('settings.json: add caveman SubagentStart hook');
    data.hooks.SubagentStart.unshift({ hooks: [hook] });
  } else if (current.command !== hook.command || JSON.stringify(current.args) !== JSON.stringify(hook.args)) {
    note("settings.json: point caveman SubagentStart hook at this device's node and home");
    Object.assign(current, hook);
  }
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
  const groups = data.hooks?.SubagentStart;
  if (Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some(isCavemanHook))) {
    note('settings.json: remove caveman SubagentStart hook');
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isCavemanHook(h)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) data.hooks.SubagentStart = kept;
    else delete data.hooks.SubagentStart;
    if (!Object.keys(data.hooks).length) delete data.hooks;
  }
  saveSettings(data, before);
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

// ---------- commands ----------

function requirePayload() {
  const missing = [FILES.style[0], FILES.hook[0], FILES.skill[0], AGENTS_SECTION].filter((p) => !fs.existsSync(p));
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
    writeText(FILES.hook[1], read(FILES.hook[0]), 'SubagentStart hook: every other sub-agent');
    ensureClaudeSkillLink();
    mergeSettings();
  }
  if (forCodex) {
    ensureAgentsSection();
    writeText(CODEX_CONFIG, withMultiAgent(read(CODEX_CONFIG) ?? ''), 'multi_agent: on by default since 0.147, pinned');
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
    deleteFile(FILES.hook[1], 'caveman SubagentStart hook');
  }
  if (forCodex) removeAgentsSection();
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
  for (const [payloadCopy, installed] of [FILES.style, FILES.hook, FILES.skill]) {
    const live = read(installed);
    if (live === null) throw new Error(`cannot export: ${installed} is missing on this device`);
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
  compareToPayload('Claude SubagentStart hook script', FILES.hook);
  let data;
  try {
    data = loadSettings().data;
  } catch (e) {
    return check('FAIL', 'Claude settings.json', e.message);
  }
  check(data.outputStyle === 'Caveman' ? 'ok' : 'FAIL', 'outputStyle is "Caveman"', `found ${JSON.stringify(data.outputStyle ?? null)}`);
  const hook = (data.hooks?.SubagentStart ?? []).flatMap((g) => g.hooks ?? []).find(isCavemanHook);
  if (!hook) {
    check('FAIL', 'SubagentStart hook registered', `not found in ${SETTINGS}`);
  } else {
    const run = spawnSync(hook.command, hook.args ?? [], {
      input: '{"hook_event_name":"SubagentStart"}',
      encoding: 'utf8',
      timeout: 10000,
    });
    let ok = false;
    try {
      const out = JSON.parse(run.stdout).hookSpecificOutput;
      ok = out?.hookEventName === 'SubagentStart' && /caveman/i.test(out?.additionalContext ?? '');
    } catch {
      // not JSON: reported below
    }
    const detail = ok ? `${hook.command} ${(hook.args ?? []).join(' ')}` : String(run.error?.message ?? run.stderr ?? 'unexpected output').trim();
    check(ok ? 'ok' : 'FAIL', 'SubagentStart hook runs and returns caveman context', detail);
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

const USAGE =
  'usage: node caveman.mjs [install|verify|uninstall|export|help] [--dry-run] [--only claude|codex] [--home DIR] [--live]\n' +
  '       no command = install (so `npx -y caveman-portable` sets up a device in one line)';

try {
  if (ONLY && !['claude', 'codex'].includes(ONLY)) throw new Error('--only must be "claude" or "codex"');
  if (['install', 'uninstall', 'export'].includes(command)) {
    if (command === 'install') install();
    else if (command === 'uninstall') uninstall();
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
    }
    if (command === 'uninstall' && actions.length) {
      console.log(`Not touched: Codex multi_agent (its default anyway) and ${EXPLANATORY_PLUGIN}; re-enable that plugin yourself if you want it.`);
    }
  } else if (command === 'verify') {
    process.exitCode = verify();
  } else {
    console.log(USAGE);
    process.exitCode = command === 'help' ? 0 : 1;
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode = 1;
}

// Status-line wrapper: draws 🪨 in the status line while the Caveman output style is active.
//
// Status-line scripts differ from person to person, so this never edits yours. The installer saves whatever
// command you had into caveman-statusline.json next to this file; this wrapper runs that command with the same
// stdin, then prefixes the badge to its output. Uninstall restores the original command.
//
// Nothing here can lose your status line: if the original fails, its own output still wins, and if anything in
// this wrapper throws, it prints what the original printed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.join(HERE, 'caveman-statusline.json');
const BADGE = '\u{1FAA8}'; // 🪨

function readStyle(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.outputStyle === 'string' ? parsed.outputStyle : null;
  } catch {
    return null;
  }
}

// Same precedence Claude Code uses: user settings first, then project settings from the filesystem root down to
// the session's directory, closest directory winning, local overriding project.
function activeStyle(cwd) {
  const configDir = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
  let style = readStyle(path.join(configDir, 'settings.json'));
  const parts = path.resolve(cwd || process.cwd()).split(path.sep);
  for (let depth = 1; depth <= parts.length; depth++) {
    const dir = parts.slice(0, depth).join(path.sep) || path.sep;
    for (const name of ['settings.json', 'settings.local.json']) {
      const found = readStyle(path.join(dir, '.claude', name));
      if (found) style = found;
    }
  }
  return style;
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');

let original = '';
try {
  original = JSON.parse(fs.readFileSync(SIDECAR, 'utf8'))?.command ?? '';
} catch {
  // no saved command: this wrapper is the whole status line
}

let inner = '';
if (original) {
  const run = spawnSync(original, { input, shell: true, encoding: 'utf8', timeout: 5000 });
  inner = (run.stdout ?? '').replace(/\s+$/, '');
}

let style = null;
try {
  style = activeStyle(JSON.parse(input || '{}')?.cwd);
} catch {
  // unreadable input: fall back to no badge rather than a wrong one
}

const caveman = (style ?? '').toLowerCase() === 'caveman';
const badge = caveman ? `${BADGE} caveman` : style ? `⚠ style: ${style}` : '';
// If the wrapped script already draws the icon, leave its line alone rather than showing it twice.
const alreadyShown = inner.includes(BADGE);
process.stdout.write([!alreadyShown && badge, inner].filter(Boolean).join(' | '));

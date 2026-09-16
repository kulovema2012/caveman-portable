// MessageDisplay hook: draws a 🪨 in front of each assistant reply while the Caveman output style is active.
// Display-only: Claude Code renders `displayContent` in place of the delta, while the transcript and what
// Claude sees keep the original text. Printing nothing (or failing) renders the original, so this can only
// ever add an icon, never eat a reply.
//
// Input per batch: { turn_id, message_id, index, final, delta, cwd, ... }. Only index 0 is marked, so one
// icon per message rather than one per streamed batch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BADGE = '\u{1FAA8} '; // 🪨

function readStyle(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof parsed.outputStyle === 'string' ? parsed.outputStyle : null;
  } catch {
    return null; // missing or unreadable file: nothing to say
  }
}

// Same precedence Claude Code uses: user settings first, then project settings from the filesystem root
// down to the session's directory, with the closest directory winning, and local overriding project.
function activeStyle(cwd) {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
  let style = readStyle(path.join(configDir, 'settings.json'));
  const parts = path.resolve(cwd).split(path.sep);
  for (let depth = 1; depth <= parts.length; depth++) {
    const dir = parts.slice(0, depth).join(path.sep) || path.sep;
    for (const name of ['settings.json', 'settings.local.json']) {
      const found = readStyle(path.join(dir, '.claude', name));
      if (found) style = found;
    }
  }
  return style;
}

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const delta = typeof input.delta === 'string' ? input.delta : '';
  if (input.index === 0 && delta && (activeStyle(input.cwd || process.cwd()) || '').toLowerCase() === 'caveman') {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'MessageDisplay', displayContent: BADGE + delta } }),
    );
  }
} catch {
  // never break rendering: no output means Claude Code draws the original text
}

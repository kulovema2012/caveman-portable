// Codex UserPromptSubmit hook: shows a per-turn notice that the caveman rules are in place.
// Codex's status line only takes built-in items, so a hook message is the closest thing to a badge.
// It reads ~/.codex/AGENTS.md directly rather than CODEX_HOME, because that is where caveman-portable
// installs the rules; it adds nothing to the model's context.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Codex sends the event payload on stdin; the trace records it so duplicate registrations can be told apart.
let stdinPayload = '';
try {
  stdinPayload = fs.readFileSync(0, 'utf8');
} catch {
  // no stdin available: tracing only
}

const agentsMd = path.join(os.homedir(), '.codex', 'AGENTS.md');
let text = '';
try {
  text = fs.readFileSync(agentsMd, 'utf8');
} catch {
  // missing file: reported below
}
// Inside an IDE such as Orca, Codex loads both ~/.codex/hooks.json and its own CODEX_HOME copy, so this hook
// runs twice per turn. The first run for a turn claims a marker file; later runs for that turn stay silent.
function firstRunForTurn(payload) {
  let turnId;
  try {
    turnId = JSON.parse(payload)?.turn_id;
  } catch {
    return true; // no payload to key on: better a duplicate notice than none
  }
  if (typeof turnId !== 'string' || !/^[\w-]{1,80}$/.test(turnId)) return true;
  const dir = path.join(os.tmpdir(), 'caveman-notice');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${turnId}.turn`), '', { flag: 'wx' });
    const stale = Date.now() - 60 * 60 * 1000;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < stale) fs.rmSync(file, { force: true });
    }
    return true;
  } catch {
    return false; // the marker already exists: a sibling registration already printed this turn
  }
}

const active = text.includes('<!-- caveman:start') || text.includes('# Response style — caveman');
const systemMessage = !firstRunForTurn(stdinPayload)
  ? ''
  : active
    ? '🪨 caveman active'
    : '⚠ caveman rules missing from ~/.codex/AGENTS.md (run: npx -y caveman-portable)';
// An empty message would render as a blank notice, so a suppressed duplicate writes nothing at all.
const output = systemMessage ? JSON.stringify({ systemMessage }) : '';
// Optional trace for debugging: set CAVEMAN_NOTICE_LOG to a file path to record each run.
if (process.env.CAVEMAN_NOTICE_LOG) {
  try {
    fs.appendFileSync(
      process.env.CAVEMAN_NOTICE_LOG,
      `${new Date().toISOString()} out=${output} in=${stdinPayload.replace(/\s+/g, ' ').slice(0, 600)}\n`,
    );
  } catch {
    // tracing must never break the hook
  }
}
process.stdout.write(output);

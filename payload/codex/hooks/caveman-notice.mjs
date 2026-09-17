// Codex UserPromptSubmit hook: shows a per-turn notice that the caveman rules are in place, and watches the
// weekly usage limit.
//
// Codex's status line only takes built-in items, so a hook message is the closest thing to a badge. Codex does
// hand hooks the session's transcript_path, and every session file carries a live rate_limits snapshot, so the
// weekly figure is read straight from there rather than guessed.
//
// It reads ~/.codex/AGENTS.md directly rather than CODEX_HOME, because that is where caveman-portable installs
// the rules, and it adds nothing to the model's context unless the limit is nearly spent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THRESHOLD = Number(process.env.CAVEMAN_LIMIT_THRESHOLD ?? 5);
const WEEKLY_MINUTES = 10080;

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

// Reads the newest rate_limits snapshot out of the tail of the session file, and returns the weekly window.
function weeklyLimit(transcriptPath) {
  if (!transcriptPath) return null;
  let tail = '';
  try {
    const { size } = fs.statSync(transcriptPath);
    const span = Math.min(size, 512 * 1024);
    const buffer = Buffer.alloc(span);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, span, size - span);
    } finally {
      fs.closeSync(fd);
    }
    tail = buffer.toString('utf8');
  } catch {
    return null;
  }
  let found = null;
  for (const line of tail.split(/\r?\n/)) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const limits = findLimits(JSON.parse(line));
      for (const window of [limits?.primary, limits?.secondary]) {
        if (window && window.window_minutes === WEEKLY_MINUTES && typeof window.used_percent === 'number') found = window;
      }
    } catch {
      // partial or unparseable line: keep looking
    }
  }
  return found;
}

function findLimits(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.rate_limits) return node.rate_limits;
  for (const key of Object.keys(node)) {
    const found = findLimits(node[key]);
    if (found) return found;
  }
  return null;
}

const active = text.includes('<!-- caveman:start') || text.includes('# Response style — caveman');
const first = firstRunForTurn(stdinPayload);

let payload = {};
try {
  payload = JSON.parse(stdinPayload || '{}');
} catch {
  // no payload: the limit watch simply stays quiet
}

const weekly = weeklyLimit(payload.transcript_path);
const remaining = weekly ? 100 - weekly.used_percent : null;
const low = typeof remaining === 'number' && remaining <= THRESHOLD;

const result = {};
if (first) {
  result.systemMessage = !active
    ? '⚠ caveman rules missing from ~/.codex/AGENTS.md (run: npx -y caveman-portable)'
    : low
      ? `🪨 caveman active · ⚠ ${remaining.toFixed(1)}% weekly limit left`
      : '🪨 caveman active';
}
if (low) {
  const resets = weekly.resets_at ? new Date(weekly.resets_at * 1000).toLocaleString() : 'an unknown time';
  // Facts plus the user's standing instruction, rather than imperative system-style text.
  result.hookSpecificOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext: [
      `Usage status: the weekly limit for Codex has ${remaining.toFixed(1)}% left and resets at ${resets}.`,
      "The user's standing instruction for this state: finish only the work already in progress, then commit the tracked changes on the current branch and push them.",
      'New work, large refactors and long searches wait until the limit resets.',
      'A task that cannot finish within a few steps is committed as work in progress and pushed rather than left uncommitted.',
    ].join(' '),
  };
}

const output = Object.keys(result).length ? JSON.stringify(result) : '';
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

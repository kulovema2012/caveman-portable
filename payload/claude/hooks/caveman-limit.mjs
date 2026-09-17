// UserPromptSubmit hook: when the weekly usage limit is nearly spent, it tells the agent to wrap up.
//
// Claude Code hooks receive no usage figures, so the status-line wrapper records the weekly number into
// caveman-limit.json beside this file and this hook reads it. While there is room left it prints nothing, so a
// normal turn costs nothing and adds nothing to the context.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SENTINEL = path.join(HERE, 'caveman-limit.json');
// The status line refreshes constantly; anything older than this is a stale reading from an earlier session.
const FRESH_MS = 10 * 60 * 1000;

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, '--no-optional-locks', 'branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const state = JSON.parse(fs.readFileSync(SENTINEL, 'utf8'));
  const threshold = typeof state.threshold === 'number' ? state.threshold : 5;
  const fresh = Date.now() - (state.at ?? 0) <= FRESH_MS;
  if (typeof state.remaining === 'number' && fresh && state.remaining <= threshold) {
    const resets = state.resets_at ? new Date(state.resets_at * 1000).toLocaleString() : 'an unknown time';
    const branch = currentBranch(input.cwd || process.cwd());
    // Written as facts plus the user's standing instruction: imperative system-style text can trip
    // Claude Code's prompt-injection defences and get surfaced to the user instead of used as context.
    const context = [
      `Usage status: the weekly limit for Claude Code has ${state.remaining.toFixed(1)}% left and resets at ${resets}.`,
      `The user's standing instruction for this state: finish only the work already in progress, then commit the tracked changes${branch ? ` on branch ${branch}` : ''} and push them.`,
      'New work, large refactors and long searches wait until the limit resets.',
      'A task that cannot finish within a few steps is committed as work in progress and pushed rather than left uncommitted.',
    ].join(' ');
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }));
  }
} catch {
  // no reading yet, or an unreadable one: say nothing
}

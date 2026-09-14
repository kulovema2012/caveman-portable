// SubagentStart hook: gives every Claude Code subagent the user's caveman reporting convention.
// Output styles only reach the main conversation and forks; other subagents run their own
// system prompt, so this is the one path that covers all agent types (Explore/Plan included).
// Phrased as facts, not commands; the hooks docs warn that imperative text can trip prompt-injection defenses.
const context = [
  "User preference (set 2026-09-14): every reply in this workspace is written in caveman style, including subagent reports back to the coordinator.",
  "Caveman style drops articles, filler, pleasantries and empty hedging. Fragments are fine, arrows show causality (X → Y), and common abbreviations are used (DB/auth/config/fn/impl/repo).",
  "Kept exact: code blocks, error messages quoted verbatim, complete file paths with line numbers, numbers, versions, commands.",
  "Kept in full prose: content written to files, destructive-action confirmations, security warnings, and ordered steps where fragments could be misread.",
  "Output required by a schema stays valid structured output; caveman applies only to its free-text fields.",
  'Example report: "12 endpoints in src/api/. Missing rate-limit on /api/payments/* → src/api/payments.ts:14."',
].join("\n");

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: context } }),
);

import type { ModelSelection } from "./client";

const T3_CLAUDE_SLUGS = new Set([
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);

/**
 * The short list of Claude models offered when starting a loop, most capable
 * first. The `id` is the T3 Code slug passed through to `claudeModelSelection`.
 */
export const CLAUDE_MODELS: Array<{ id: string; label: string }> = [
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  { id: "claude-fable-5", label: "Fable 5" },
];

/**
 * Map a configured Claude model id (possibly with a dated suffix) to T3 Code's
 * built-in Claude slug. Unknown ids fall through to Fable 5.
 */
function toT3ClaudeSlug(model: string): string {
  if (T3_CLAUDE_SLUGS.has(model)) return model;
  if (model.startsWith("claude-haiku-4-5")) return "claude-haiku-4-5";
  if (model.startsWith("claude-sonnet-4-5")) return "claude-sonnet-4-6";
  return "claude-fable-5";
}

/**
 * Always route threads through T3's built-in Claude provider (`claudeAgent`)
 * rather than a project's stored default, which may point at a disabled
 * provider. "xhigh"/"200k" are valid for Fable 5 and the Opus tiers.
 */
export function claudeModelSelection(model: string): ModelSelection {
  return {
    instanceId: "claudeAgent",
    model: toT3ClaudeSlug(model),
    options: { effort: "xhigh", contextWindow: "200k" },
  };
}

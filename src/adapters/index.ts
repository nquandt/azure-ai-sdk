import { generateId } from '@ai-sdk/provider-utils';
import { AdapterType, ChatAdapter } from './types.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { OpenAILegacyAdapter } from './openai-legacy-adapter.js';

export { OpenAIAdapter } from './openai-adapter.js';
export { OpenAILegacyAdapter } from './openai-legacy-adapter.js';
export type { AdapterType, ChatAdapter } from './types.js';

// ---------------------------------------------------------------------------
// Model ID heuristics
//
// These patterns are a best-effort fallback when the user has not explicitly
// set adapterType. Explicit always wins — these only fire when adapterType
// is undefined.
//
// Pattern rationale:
//   openai       — o-series reasoning models and gpt-5+ family use
//                  max_completion_tokens and reject temperature=0
//   openai-legacy — gpt-4o, gpt-4, gpt-35-turbo use max_tokens
//
// When new model families are added (Anthropic, Mistral, etc.) the heuristic
// list grows here; no changes needed in the language model class itself.
// ---------------------------------------------------------------------------

const OPENAI_PATTERNS = [
  /^o\d/i,           // o1, o3, o4-mini, o1-preview, …
  /^gpt-5/i,         // gpt-5, gpt-5-nano, gpt-5-mini, …
  /^gpt-4\.5/i,      // gpt-4.5-preview
];

const OPENAI_LEGACY_PATTERNS = [
  /^gpt-4o/i,        // gpt-4o, gpt-4o-mini
  /^gpt-4/i,         // gpt-4, gpt-4-turbo
  /^gpt-35/i,        // gpt-35-turbo (Azure deployment name style)
  /^gpt-3\.5/i,      // gpt-3.5-turbo
];

function detectAdapterType(modelId: string): AdapterType {
  const id = modelId.toLowerCase();

  for (const pattern of OPENAI_LEGACY_PATTERNS) {
    if (pattern.test(id)) return 'openai-legacy';
  }

  for (const pattern of OPENAI_PATTERNS) {
    if (pattern.test(id)) return 'openai';
  }

  // Unknown model — default to openai (max_completion_tokens) since that is
  // the direction Azure/OpenAI is heading and covers new models by default.
  return 'openai';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Resolve and instantiate the correct ChatAdapter for a given model.
 *
 * Resolution order:
 *   1. Explicit adapterType from settings — user always wins
 *   2. Model ID heuristic — pattern-matched against known model families
 *   3. Default: 'openai'
 */
export function resolveAdapter(
  modelId: string,
  adapterType: AdapterType | undefined,
  idGenerator: () => string = generateId,
): ChatAdapter {
  const resolved = adapterType ?? detectAdapterType(modelId);

  switch (resolved) {
    case 'openai':
      return new OpenAIAdapter(idGenerator);
    case 'openai-legacy':
      return new OpenAILegacyAdapter(idGenerator);
    case 'anthropic':
      // Placeholder — AnthropicAdapter will be implemented when Anthropic
      // support is added. Throw early with a clear message rather than
      // silently falling back.
      throw new Error(
        `@nquandt/azure-ai-sdk: adapterType 'anthropic' is not yet implemented.`,
      );
    default: {
      // Exhaustiveness check — TypeScript will error here if AdapterType
      // gains a new member without a corresponding case above.
      const _exhaustive: never = resolved;
      throw new Error(`@nquandt/azure-ai-sdk: unknown adapterType '${_exhaustive}'.`);
    }
  }
}

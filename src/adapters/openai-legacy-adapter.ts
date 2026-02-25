import {
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
} from '@ai-sdk/provider';
import { convertToOpenAIMessages, OpenAIAdapter, openAIChunkSchema, openAIResponseSchema } from './openai-adapter.js';

// ---------------------------------------------------------------------------
// OpenAI-legacy adapter  (max_tokens — gpt-4o and older)
//
// Identical to OpenAIAdapter except:
//   - uses `max_tokens` instead of `max_completion_tokens`
//   - forwards temperature/top_p as-is (older models accept 0 without error)
// ---------------------------------------------------------------------------

export class OpenAILegacyAdapter extends OpenAIAdapter {
  override readonly responseSchema = openAIResponseSchema;
  override readonly chunkSchema = openAIChunkSchema;

  override buildRequest(
    options: LanguageModelV2CallOptions,
    modelId: string,
    modelInBody: boolean,
  ): { body: Record<string, unknown>; warnings: LanguageModelV2CallWarning[] } {
    // Delegate to parent to get warnings, tool setup, and message conversion,
    // then swap out the token-limit key and temperature handling.
    const { body, warnings } = super.buildRequest(options, modelId, modelInBody);

    // Parent emits max_completion_tokens — replace with max_tokens
    const { max_completion_tokens, ...rest } = body;
    const legacyBody: Record<string, unknown> = {
      ...rest,
      ...(max_completion_tokens !== undefined ? { max_tokens: max_completion_tokens } : {}),
    };

    // Legacy models accept temperature=0 explicitly — override the parent's
    // suppression of 0 values and re-apply the raw SDK values.
    const messages = convertToOpenAIMessages(options.prompt);
    legacyBody.messages = messages;

    if (options.temperature !== undefined) legacyBody.temperature = options.temperature;
    if (options.topP !== undefined) legacyBody.top_p = options.topP;

    // Clean undefined
    for (const key of Object.keys(legacyBody)) {
      if (legacyBody[key] === undefined) delete legacyBody[key];
    }

    return { body: legacyBody, warnings };
  }
}

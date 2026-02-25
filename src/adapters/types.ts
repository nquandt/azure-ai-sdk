import {
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
} from '@ai-sdk/provider';
import { ParseResult } from '@ai-sdk/provider-utils';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Adapter type discriminant
// ---------------------------------------------------------------------------

export type AdapterType = 'openai' | 'openai-legacy' | 'anthropic';

// ---------------------------------------------------------------------------
// Normalised structures the language model works with internally
// ---------------------------------------------------------------------------

export type ParsedResponse = {
  content: LanguageModelV2Content[];
  finishReason: LanguageModelV2FinishReason;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
};

export type ParsedStreamChunk =
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-start'; id: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
  | { type: 'finish'; finishReason: LanguageModelV2FinishReason; usage: { inputTokens: number | undefined; outputTokens: number | undefined } }
  | { type: 'error'; error: unknown };

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/**
 * A ChatAdapter owns the wire-format for a specific model family.
 * It translates between the AI SDK's LanguageModelV2 abstractions and the
 * raw HTTP request/response shapes expected by that family's API.
 *
 * Implementing a new adapter (e.g. Anthropic, Mistral, Cohere) requires only
 * this interface — the core language model class is untouched.
 */
export interface ChatAdapter<TResponseRaw = unknown, TChunkRaw = unknown> {
  /**
   * Build the JSON request body and surface any unsupported-setting warnings.
   */
  buildRequest(
    options: LanguageModelV2CallOptions,
    modelId: string,
    modelInBody: boolean,
  ): {
    body: Record<string, unknown>;
    warnings: LanguageModelV2CallWarning[];
  };

  /**
   * Zod schema used to validate the non-streaming response.
   */
  responseSchema: z.ZodType<TResponseRaw>;

  /**
   * Zod schema used to validate each SSE chunk in a streaming response.
   */
  chunkSchema: z.ZodType<TChunkRaw>;

  /**
   * Parse a validated non-streaming response into normalised form.
   */
  parseResponse(raw: TResponseRaw): ParsedResponse;

  /**
   * Parse a validated SSE chunk. Returns an array of zero or more stream
   * parts — some chunks carry multiple logical events (e.g. a delta + finish).
   * The language model calls this once per chunk and enqueues every result.
   *
   * Stateful adapters (e.g. tool-call accumulation) should keep their state
   * as instance fields and expose a `flush()` for any deferred events.
   */
  parseChunk(raw: ParseResult<TChunkRaw>): ParsedStreamChunk[];

  /**
   * Called once after the SSE stream closes. Return any deferred events
   * (e.g. completed tool calls, final usage, finish reason).
   */
  flush(): ParsedStreamChunk[];
}

import {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  SharedV3Warning,
} from '@ai-sdk/provider';
import { ParseResult } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { ChatAdapter, ParsedResponse, ParsedStreamChunk } from './types.js';

// ---------------------------------------------------------------------------
// Wire types — Anthropic Messages API
// ---------------------------------------------------------------------------

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

type ChatMessage =
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[] };

type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const textContentBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const toolUseContentBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
});

const contentBlockSchema = z.union([textContentBlockSchema, toolUseContentBlockSchema]);

export const anthropicResponseSchema = z.object({
  id: z.string().nullish(),
  type: z.string().nullish(),
  role: z.string().nullish(),
  content: z.array(contentBlockSchema),
  model: z.string().nullish(),
  stop_reason: z.string().nullish(),
  stop_sequence: z.string().nullish(),
  usage: z
    .object({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
    })
    .nullish(),
});

// Anthropic streaming uses Server-Sent Events with different message types
const anthropicStreamMessageStartSchema = z.object({
  type: z.literal('message_start'),
  message: z.object({
    id: z.string(),
    type: z.string(),
    role: z.string(),
    content: z.array(z.unknown()),
    model: z.string().nullish(),
    stop_reason: z.string().nullish(),
    usage: z
      .object({
        input_tokens: z.number(),
        output_tokens: z.number(),
      })
      .nullish(),
  }),
});

const anthropicStreamContentBlockStartSchema = z.object({
  type: z.literal('content_block_start'),
  index: z.number(),
  content_block: z.object({
    type: z.string(),
    text: z.string().optional(),
    id: z.string().optional(),
    name: z.string().optional(),
    input: z.unknown().optional(),
  }),
});

const anthropicStreamContentBlockDeltaSchema = z.object({
  type: z.literal('content_block_delta'),
  index: z.number(),
  delta: z.union([
    z.object({ type: z.literal('text_delta'), text: z.string() }),
    z.object({ type: z.literal('input_json_delta'), partial_json: z.string() }),
  ]),
});

const anthropicStreamContentBlockStopSchema = z.object({
  type: z.literal('content_block_stop'),
  index: z.number(),
});

const anthropicStreamMessageDeltaSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z.string().nullish(),
    stop_sequence: z.string().nullish(),
  }),
  usage: z
    .object({
      output_tokens: z.number(),
    })
    .nullish(),
});

const anthropicStreamMessageStopSchema = z.object({
  type: z.literal('message_stop'),
});

const anthropicStreamPingSchema = z.object({
  type: z.literal('ping'),
});

const anthropicChunkSchema = z.union([
  anthropicStreamMessageStartSchema,
  anthropicStreamContentBlockStartSchema,
  anthropicStreamContentBlockDeltaSchema,
  anthropicStreamContentBlockStopSchema,
  anthropicStreamMessageDeltaSchema,
  anthropicStreamMessageStopSchema,
  anthropicStreamPingSchema,
]);

type AnthropicResponse = z.infer<typeof anthropicResponseSchema>;
type AnthropicChunk = z.infer<typeof anthropicChunkSchema>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string | null | undefined): LanguageModelV3FinishReason {
  const raw = reason ?? undefined;
  const unified = ((): LanguageModelV3FinishReason['unified'] => {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'max_tokens': return 'length';
      case 'tool_use': return 'tool-calls';
      case 'stop_sequence': return 'stop';
      default: return 'other';
    }
  })();
  return { unified, raw };
}

function convertToAnthropicMessages(
  prompt: LanguageModelV3CallOptions['prompt'],
): { messages: ChatMessage[]; system: string | undefined } {
  const messages: ChatMessage[] = [];
  let systemPrompt: string | undefined;

  for (const message of prompt) {
    switch (message.role) {
      case 'system': {
        // Anthropic expects system as a separate parameter, not a message
        systemPrompt = message.content;
        break;
      }

      case 'user': {
        const content: ContentBlock[] = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            content.push({ type: 'text', text: part.text });
          } else if (part.type === 'file') {
            const { data, mediaType } = part;
            // Anthropic supports images via base64 URLs
            if (mediaType.startsWith('image/')) {
              let base64Data: string;
              if (data instanceof URL) {
                // For URLs, we'd need to fetch them; for now, treat as external
                content.push({ type: 'text', text: `[Image URL: ${data.href}]` });
              } else if (typeof data === 'string') {
                base64Data = data;
              } else {
                base64Data = Buffer.from(data).toString('base64');
              }
              if (typeof data !== 'string' && !(data instanceof URL)) {
                // Image blocks would go here, but Anthropic's model format differs
                content.push({ type: 'text', text: `[Image: ${mediaType}]` });
              }
            }
          }
        }
        messages.push({ role: 'user', content });
        break;
      }

      case 'assistant': {
        const content: ContentBlock[] = [];
        let textContent = '';

        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              textContent += part.text;
              break;
            case 'tool-call':
              if (textContent) {
                content.push({ type: 'text', text: textContent });
                textContent = '';
              }
              content.push({
                type: 'tool_use',
                id: part.toolCallId,
                name: part.toolName,
                input: typeof part.input === 'string' ? JSON.parse(part.input) : part.input,
              });
              break;
          }
        }

        if (textContent) {
          content.push({ type: 'text', text: textContent });
        }

        messages.push({ role: 'assistant', content });
        break;
      }

      case 'tool': {
        for (const part of message.content) {
          if (part.type !== 'tool-result') continue;
          const content: string = toolResultToString(part.output as unknown as { type: string; value?: unknown });
          messages.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Tool result from ${part.toolCallId}: ${content}`,
              },
            ],
          });
        }
        break;
      }
    }
  }

  return { messages, system: systemPrompt };
}

function toolResultToString(output: { type: string; value?: unknown }): string {
  if (output.type === 'text' || output.type === 'error-text') {
    return String(output.value ?? '');
  }
  if (output.type === 'json' || output.type === 'error-json') {
    return JSON.stringify(output.value);
  }
  if (output.type === 'content' && Array.isArray(output.value)) {
    return (output.value as { type: string; text?: string }[])
      .map((p) => p.text ?? '')
      .join('');
  }
  return JSON.stringify(output);
}

function buildTools(options: LanguageModelV3CallOptions): {
  tools: unknown;
  warnings: SharedV3Warning[];
} {
  const warnings: SharedV3Warning[] = [];
  let tools: unknown;

  if (options.topK != null) warnings.push({ type: 'unsupported', feature: 'topK' });
  if (options.presencePenalty != null) warnings.push({ type: 'unsupported', feature: 'presencePenalty' });
  if (options.frequencyPenalty != null) warnings.push({ type: 'unsupported', feature: 'frequencyPenalty' });

  if (options.tools && options.tools.length > 0) {
    tools = options.tools
      .filter((t) => t.type === 'function')
      .map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: (t as { inputSchema?: unknown }).inputSchema,
      }));
  }

  return { tools, warnings };
}

// ---------------------------------------------------------------------------
// Anthropic adapter (Messages API for Azure Foundry)
// ---------------------------------------------------------------------------

export class AnthropicAdapter implements ChatAdapter<AnthropicResponse, AnthropicChunk> {
  readonly responseSchema = anthropicResponseSchema;
  readonly chunkSchema = anthropicChunkSchema;

  // Anthropic Messages API path — overrides the default '/chat/completions'
  readonly urlSuffix = '/anthropic/v1/messages';

  // Required by the Anthropic API
  readonly additionalHeaders = { 'anthropic-version': '2023-06-01' };
  private finishReason: LanguageModelV3FinishReason = { unified: 'other', raw: undefined };
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private readonly toolCallAccumulators = new Map<
    number,
    { id: string; name: string; inputJson: string }
  >();
  private readonly openTextIds = new Set<string>();
  private readonly generateId: () => string;

  constructor(generateId: () => string) {
    this.generateId = generateId;
  }

  buildRequest(
    options: LanguageModelV3CallOptions,
    modelId: string,
    modelInBody: boolean,
  ): { body: Record<string, unknown>; warnings: SharedV3Warning[] } {
    const { tools, warnings } = buildTools(options);
    const { messages, system } = convertToAnthropicMessages(options.prompt);

    // Suppress temperature/top_p of 0
    const explicitTemperature = options.temperature !== 0 ? options.temperature : undefined;
    const explicitTopP = options.topP !== 0 ? options.topP : undefined;

    const body: Record<string, unknown> = {
      ...(modelInBody ? { model: modelId } : {}),
      messages,
      max_tokens: options.maxOutputTokens ?? 4096,
      temperature: explicitTemperature,
      top_p: explicitTopP,
      ...(system ? { system } : {}),
      ...(tools != null ? { tools } : {}),
    };

    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key];
    }

    return { body, warnings };
  }

  parseResponse(raw: AnthropicResponse): ParsedResponse {
    const content: LanguageModelV3Content[] = [];

    for (const block of raw.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        content.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: JSON.stringify(block.input),
        });
      }
    }

    return {
      content,
      finishReason: mapFinishReason(raw.stop_reason),
      usage: {
        inputTokens: raw.usage?.input_tokens ?? undefined,
        outputTokens: raw.usage?.output_tokens ?? undefined,
      },
    };
  }

  parseChunk(chunk: ParseResult<AnthropicChunk>): ParsedStreamChunk[] {
    if (!chunk.success) return [{ type: 'error', error: chunk.error }];

    const parts: ParsedStreamChunk[] = [];
    const value = chunk.value;

    switch (value.type) {
      case 'message_start': {
        if (value.message.usage) {
          this.inputTokens = value.message.usage.input_tokens;
        }
        break;
      }

      case 'content_block_start': {
        const idx = value.index;
        if (value.content_block.type === 'text') {
          const textId = `text-${idx}`;
          this.openTextIds.add(textId);
          parts.push({ type: 'text-start', id: textId });
        } else if (value.content_block.type === 'tool_use') {
          const toolId = value.content_block.id ?? this.generateId();
          const toolName = value.content_block.name ?? '';
          this.toolCallAccumulators.set(idx, {
            id: toolId,
            name: toolName,
            inputJson: '',
          });
          parts.push({ type: 'tool-input-start', id: toolId, toolName });
        }
        break;
      }

      case 'content_block_delta': {
        const idx = value.index;
        const delta = value.delta;

        if (delta.type === 'text_delta') {
          const textId = `text-${idx}`;
          parts.push({ type: 'text-delta', id: textId, delta: delta.text });
        } else if (delta.type === 'input_json_delta') {
          const acc = this.toolCallAccumulators.get(idx);
          if (acc) {
            acc.inputJson += delta.partial_json;
            parts.push({ type: 'tool-input-delta', id: acc.id, delta: delta.partial_json });
          }
        }
        break;
      }

      case 'content_block_stop': {
        const idx = value.index;
        const acc = this.toolCallAccumulators.get(idx);
        if (acc) {
          const textId = `text-${idx}`;
          if (this.openTextIds.has(textId)) {
            parts.push({ type: 'text-end', id: textId });
          }
        }
        break;
      }

      case 'message_delta': {
        if (value.delta.stop_reason) {
          this.finishReason = mapFinishReason(value.delta.stop_reason);
        }
        if (value.usage) {
          this.outputTokens = value.usage.output_tokens;
        }
        break;
      }

      case 'message_stop': {
        // End of stream
        break;
      }
    }

    return parts;
  }

  flush(): ParsedStreamChunk[] {
    const parts: ParsedStreamChunk[] = [];

    for (const textId of this.openTextIds) {
      parts.push({ type: 'text-end', id: textId });
    }

    for (const acc of this.toolCallAccumulators.values()) {
      parts.push({ type: 'tool-input-end', id: acc.id });
      parts.push({ type: 'tool-call', toolCallId: acc.id, toolName: acc.name, input: acc.inputJson });
    }

    parts.push({
      type: 'finish',
      finishReason: this.finishReason,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
    });

    return parts;
  }
}

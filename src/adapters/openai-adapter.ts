import {
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
} from '@ai-sdk/provider';
import { ParseResult } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { ChatAdapter, ParsedResponse, ParsedStreamChunk } from './types.js';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: ChatUserContent[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallRequest[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type ChatUserContent =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type ToolCallRequest = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

export const openAIResponseSchema = z.object({
  id: z.string().nullish(),
  model: z.string().nullish(),
  created: z.number().nullish(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: z.object({
        role: z.literal('assistant'),
        content: z.string().nullish(),
        tool_calls: z.array(toolCallSchema).nullish(),
      }),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      total_tokens: z.number().nullish(),
    })
    .nullish(),
});

export const openAIChunkSchema = z.object({
  id: z.string().nullish(),
  model: z.string().nullish(),
  choices: z.array(
    z.object({
      index: z.number(),
      delta: z.object({
        role: z.enum(['assistant']).optional(),
        content: z.string().nullish(),
        tool_calls: z
          .array(
            z.object({
              index: z.number(),
              id: z.string().nullish(),
              type: z.literal('function').nullish(),
              function: z.object({
                name: z.string().nullish(),
                arguments: z.string().nullish(),
              }),
            }),
          )
          .nullish(),
      }),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
    })
    .nullish(),
});

type OpenAIResponse = z.infer<typeof openAIResponseSchema>;
type OpenAIChunk = z.infer<typeof openAIChunkSchema>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function mapFinishReason(reason: string | null | undefined): LanguageModelV2FinishReason {
  switch (reason) {
    case 'stop': return 'stop';
    case 'length': return 'length';
    case 'content_filter': return 'content-filter';
    case 'tool_calls': return 'tool-calls';
    default: return 'other';
  }
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

export function convertToOpenAIMessages(
  prompt: LanguageModelV2CallOptions['prompt'],
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const message of prompt) {
    switch (message.role) {
      case 'system': {
        messages.push({ role: 'system', content: message.content });
        break;
      }

      case 'user': {
        const parts: ChatUserContent[] = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            parts.push({ type: 'text', text: part.text });
          } else if (part.type === 'file') {
            const { data, mediaType } = part;
            if (mediaType.startsWith('image/')) {
              if (data instanceof URL) {
                parts.push({ type: 'image_url', image_url: { url: data.href } });
              } else if (typeof data === 'string') {
                parts.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } });
              } else {
                const b64 = Buffer.from(data).toString('base64');
                parts.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } });
              }
            }
          }
        }
        messages.push({ role: 'user', content: parts });
        break;
      }

      case 'assistant': {
        let textContent: string | null = null;
        const toolCalls: ToolCallRequest[] = [];

        for (const part of message.content) {
          switch (part.type) {
            case 'text':
              textContent = (textContent ?? '') + part.text;
              break;
            case 'tool-call':
              toolCalls.push({
                id: part.toolCallId,
                type: 'function',
                function: {
                  name: part.toolName,
                  arguments: typeof part.input === 'string'
                    ? part.input
                    : JSON.stringify(part.input),
                },
              });
              break;
          }
        }

        messages.push({
          role: 'assistant',
          content: textContent,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
        break;
      }

      case 'tool': {
        for (const part of message.content) {
          messages.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            content: toolResultToString(part.output as any),
          });
        }
        break;
      }
    }
  }

  return messages;
}

function buildToolsAndChoice(options: LanguageModelV2CallOptions): {
  tools: unknown;
  tool_choice: unknown;
  warnings: LanguageModelV2CallWarning[];
} {
  const warnings: LanguageModelV2CallWarning[] = [];
  let tools: unknown;
  let tool_choice: unknown;

  if (options.topK != null) warnings.push({ type: 'unsupported-setting', setting: 'topK' });
  if (options.presencePenalty != null) warnings.push({ type: 'unsupported-setting', setting: 'presencePenalty' });
  if (options.frequencyPenalty != null) warnings.push({ type: 'unsupported-setting', setting: 'frequencyPenalty' });

  if (options.tools && options.tools.length > 0) {
    tools = options.tools
      .filter((t) => t.type === 'function')
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: (t as { inputSchema?: unknown }).inputSchema,
        },
      }));
  }

  if (options.toolChoice) {
    const tc = options.toolChoice;
    if (tc.type === 'auto') tool_choice = 'auto';
    else if (tc.type === 'none') tool_choice = 'none';
    else if (tc.type === 'required') tool_choice = 'required';
    else if (tc.type === 'tool') tool_choice = { type: 'function', function: { name: tc.toolName } };
  }

  return { tools, tool_choice, warnings };
}

// ---------------------------------------------------------------------------
// OpenAI adapter  (max_completion_tokens — o-series, gpt-5+)
// ---------------------------------------------------------------------------

export class OpenAIAdapter implements ChatAdapter<OpenAIResponse, OpenAIChunk> {
  readonly responseSchema = openAIResponseSchema;
  readonly chunkSchema = openAIChunkSchema;

  // Streaming state
  private finishReason: LanguageModelV2FinishReason = 'other';
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private readonly toolCallAccumulators = new Map<
    number,
    { id: string; name: string; argumentsText: string }
  >();
  private readonly openTextIds = new Set<string>();
  private readonly generateId: () => string;

  constructor(generateId: () => string) {
    this.generateId = generateId;
  }

  buildRequest(
    options: LanguageModelV2CallOptions,
    modelId: string,
    modelInBody: boolean,
  ): { body: Record<string, unknown>; warnings: LanguageModelV2CallWarning[] } {
    const { tools, tool_choice, warnings } = buildToolsAndChoice(options);
    const messages = convertToOpenAIMessages(options.prompt);

    if (options.responseFormat?.type === 'json') {
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: 'Respond with a valid JSON object only. Do not include any markdown formatting or additional text.' }],
      });
    }

    // Suppress temperature/top_p of 0 — some newer models reject explicit 0
    const explicitTemperature =
      (options.temperature !== 0 ? options.temperature : undefined);
    const explicitTopP =
      (options.topP !== 0 ? options.topP : undefined);

    const body: Record<string, unknown> = {
      ...(modelInBody ? { model: modelId } : {}),
      messages,
      max_completion_tokens: options.maxOutputTokens,
      temperature: explicitTemperature,
      top_p: explicitTopP,
      stop: options.stopSequences,
      seed: options.seed,
      ...(tools != null ? { tools } : {}),
      ...(tool_choice != null ? { tool_choice } : {}),
    };

    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key];
    }

    return { body, warnings };
  }

  parseResponse(raw: OpenAIResponse): ParsedResponse {
    const choice = raw.choices[0];
    const message = choice?.message;
    const content: LanguageModelV2Content[] = [];

    if (message?.content) content.push({ type: 'text', text: message.content });

    if (message?.tool_calls && message.tool_calls.length > 0) {
      for (const tc of message.tool_calls) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: tc.function.arguments,
        });
      }
    }

    return {
      content,
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: {
        inputTokens: raw.usage?.prompt_tokens ?? undefined,
        outputTokens: raw.usage?.completion_tokens ?? undefined,
        totalTokens: raw.usage?.total_tokens ?? undefined,
      },
    };
  }

  parseChunk(chunk: ParseResult<OpenAIChunk>): ParsedStreamChunk[] {
    if (!chunk.success) return [{ type: 'error', error: chunk.error }];

    const parts: ParsedStreamChunk[] = [];
    const value = chunk.value;

    if (value.usage) {
      this.inputTokens = value.usage.prompt_tokens ?? undefined;
      this.outputTokens = value.usage.completion_tokens ?? undefined;
    }

    for (const choice of value.choices) {
      const delta = choice.delta;

      if (delta.content) {
        const textId = 'text-0';
        if (!this.openTextIds.has(textId)) {
          this.openTextIds.add(textId);
          parts.push({ type: 'text-start', id: textId });
        }
        parts.push({ type: 'text-delta', id: textId, delta: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!this.toolCallAccumulators.has(idx)) {
            const toolCallId = tc.id ?? this.generateId();
            this.toolCallAccumulators.set(idx, {
              id: toolCallId,
              name: tc.function?.name ?? '',
              argumentsText: tc.function?.arguments ?? '',
            });
            parts.push({ type: 'tool-input-start', id: toolCallId, toolName: tc.function?.name ?? '' });
            if (tc.function?.arguments) {
              parts.push({ type: 'tool-input-delta', id: toolCallId, delta: tc.function.arguments });
            }
          } else {
            const acc = this.toolCallAccumulators.get(idx)!;
            const argsDelta = tc.function?.arguments ?? '';
            acc.argumentsText += argsDelta;
            if (argsDelta) {
              parts.push({ type: 'tool-input-delta', id: acc.id, delta: argsDelta });
            }
          }
        }
      }

      if (choice.finish_reason != null) {
        this.finishReason = mapFinishReason(choice.finish_reason);
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
      parts.push({ type: 'tool-call', toolCallId: acc.id, toolName: acc.name, input: acc.argumentsText });
    }

    parts.push({
      type: 'finish',
      finishReason: this.finishReason,
      usage: { inputTokens: this.inputTokens, outputTokens: this.outputTokens },
    });

    return parts;
  }
}

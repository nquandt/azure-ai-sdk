import {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
} from '@ai-sdk/provider';
import {
  FetchFunction,
  ParseResult,
  combineHeaders,
  createEventSourceResponseHandler,
  createJsonResponseHandler,
  generateId,
  postJsonToApi,
} from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { azureFoundryFailedResponseHandler } from './azure-foundry-error.js';
import {
  AzureFoundryChatModelId,
  AzureFoundryChatSettings,
} from './azure-foundry-chat-options.js';
import { VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type AzureFoundryChatConfig = {
  provider: string;
  /**
   * Builds the full chat completions URL for a given deployment/model ID.
   */
  url: (modelId: string) => string;
  /**
   * When true, the model ID is sent in the request body as `model`.
   * Used for AI Foundry inference endpoints (services.ai.azure.com/models).
   */
  modelInBody: boolean;
  /**
   * Returns Bearer token headers for every request.
   */
  headers: () => Promise<Record<string, string>>;
  fetch?: FetchFunction;
  generateId?: () => string;
};

// ---------------------------------------------------------------------------
// Request / response shapes
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
// Zod schemas for response parsing
// ---------------------------------------------------------------------------

const toolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

const chatResponseSchema = z.object({
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

const chatChunkSchema = z.object({
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string | null | undefined): LanguageModelV2FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content-filter';
    case 'tool_calls':
      return 'tool-calls';
    default:
      return 'other';
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

function convertToAzureMessages(
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
            // Only handle image files via image_url
            const { data, mediaType } = part;
            if (mediaType.startsWith('image/')) {
              if (data instanceof URL) {
                parts.push({
                  type: 'image_url',
                  image_url: { url: data.href },
                });
              } else if (typeof data === 'string') {
                // base64 string
                parts.push({
                  type: 'image_url',
                  image_url: { url: `data:${mediaType};base64,${data}` },
                });
              } else {
                // Uint8Array
                const b64 = Buffer.from(data).toString('base64');
                parts.push({
                  type: 'image_url',
                  image_url: { url: `data:${mediaType};base64,${b64}` },
                });
              }
            }
            // non-image files: skip (warnings handled in getArgs)
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
            // reasoning / tool-result: skip
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
            content: toolResultToString(part.output as any),
          });
        }
        break;
      }
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Language model implementation
// ---------------------------------------------------------------------------

export class AzureFoundryChatLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;

  readonly modelId: AzureFoundryChatModelId;

  // LanguageModelV2 requires supportedUrls
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private readonly settings: AzureFoundryChatSettings;
  private readonly config: AzureFoundryChatConfig;
  private readonly _generateId: () => string;

  constructor(
    modelId: AzureFoundryChatModelId,
    settings: AzureFoundryChatSettings,
    config: AzureFoundryChatConfig,
  ) {
    this.modelId = modelId;
    this.settings = settings;
    this.config = config;
    this._generateId = config.generateId ?? generateId;
  }

  get provider(): string {
    return this.config.provider;
  }

  // -------------------------------------------------------------------------
  // Build request body
  // -------------------------------------------------------------------------

  private getArgs(options: LanguageModelV2CallOptions) {
    const warnings: LanguageModelV2CallWarning[] = [];

    if (options.topK != null) {
      warnings.push({ type: 'unsupported-setting', setting: 'topK' });
    }

    if (options.presencePenalty != null) {
      warnings.push({
        type: 'unsupported-setting',
        setting: 'presencePenalty',
      });
    }

    if (options.frequencyPenalty != null) {
      warnings.push({
        type: 'unsupported-setting',
        setting: 'frequencyPenalty',
      });
    }

    const messages = convertToAzureMessages(options.prompt);

    // Tool setup — V2: tools/toolChoice are top-level, no more mode.type
    let tools: unknown;
    let tool_choice: unknown;

    if (options.tools && options.tools.length > 0) {
      tools = options.tools
        .filter((t) => t.type === 'function')
        .map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            // V2 uses inputSchema instead of parameters
            parameters: (t as { inputSchema?: unknown }).inputSchema,
          },
        }));
    }

    if (options.toolChoice) {
      const tc = options.toolChoice;
      if (tc.type === 'auto') {
        tool_choice = 'auto';
      } else if (tc.type === 'none') {
        tool_choice = 'none';
      } else if (tc.type === 'required') {
        tool_choice = 'required';
      } else if (tc.type === 'tool') {
        tool_choice = {
          type: 'function',
          function: { name: tc.toolName },
        };
      }
    }

    // Handle JSON response format
    if (options.responseFormat?.type === 'json') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Respond with a valid JSON object only. Do not include any markdown formatting or additional text.',
          },
        ],
      });
    }

    // Only include temperature / top_p when explicitly configured.
    // Some models (e.g. gpt-5-nano) only accept the server-side default and reject 0.
    const explicitTemperature =
      this.settings.temperature ??
      (options.temperature !== 0 ? options.temperature : undefined);
    const explicitTopP =
      this.settings.topP ??
      (options.topP !== 0 ? options.topP : undefined);

    const body: Record<string, unknown> = {
      ...(this.config.modelInBody ? { model: this.modelId } : {}),
      messages,
      max_tokens: options.maxOutputTokens ?? this.settings.maxTokens,
      temperature: explicitTemperature,
      top_p: explicitTopP,
      stop: options.stopSequences,
      seed: options.seed,
      ...(tools != null ? { tools } : {}),
      ...(tool_choice != null ? { tool_choice } : {}),
    };

    // Remove undefined values
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) {
        delete body[key];
      }
    }

    return { body, warnings };
  }

  // -------------------------------------------------------------------------
  // doGenerate
  // -------------------------------------------------------------------------

  async doGenerate(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2['doGenerate']>>> {
    const { body, warnings } = this.getArgs(options);
    const headers = await this.config.headers();

    const { value: response, responseHeaders } = await postJsonToApi({
      url: this.config.url(this.modelId),
      headers: combineHeaders(headers, options.headers, {
        'x-ms-useragent': `@nquandt/azure-ai-sdk/${VERSION}`,
      }),
      body,
      failedResponseHandler: azureFoundryFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(chatResponseSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });

    const choice = response.choices[0];
    const message = choice?.message;

    const content: LanguageModelV2Content[] = [];

    if (message?.content) {
      content.push({ type: 'text', text: message.content });
    }

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
        inputTokens: response.usage?.prompt_tokens ?? undefined,
        outputTokens: response.usage?.completion_tokens ?? undefined,
        totalTokens: response.usage?.total_tokens ?? undefined,
      },
      warnings,
      request: { body },
      response: {
        headers: responseHeaders,
      },
    };
  }

  // -------------------------------------------------------------------------
  // doStream
  // -------------------------------------------------------------------------

  async doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2['doStream']>>> {
    const { body, warnings } = this.getArgs(options);
    const headers = await this.config.headers();

    const { value: stream, responseHeaders: streamResponseHeaders } =
      await postJsonToApi({
        url: this.config.url(this.modelId),
        headers: combineHeaders(headers, options.headers, {
          'x-ms-useragent': `@nquandt/azure-ai-sdk/${VERSION}`,
        }),
        body: { ...body, stream: true },
        failedResponseHandler: azureFoundryFailedResponseHandler,
        successfulResponseHandler: createEventSourceResponseHandler(chatChunkSchema),
        abortSignal: options.abortSignal,
        fetch: this.config.fetch,
      });

    let finishReason: LanguageModelV2FinishReason = 'other';
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    // Track streaming tool calls assembled across multiple deltas
    const toolCallAccumulators: Map<
      number,
      { id: string; name: string; argumentsText: string }
    > = new Map();
    // Track which text stream IDs have been opened
    const openTextIds = new Set<string>();

    const generateIdFn = this._generateId;

    // We emit stream-start as the first part to carry warnings
    const streamStart: LanguageModelV2StreamPart = {
      type: 'stream-start',
      warnings,
    };

    const coreStream = stream.pipeThrough(
      new TransformStream<
        ParseResult<z.infer<typeof chatChunkSchema>>,
        LanguageModelV2StreamPart
      >({
        start(controller) {
          controller.enqueue(streamStart);
        },

        transform(chunk, controller) {
          if (!chunk.success) {
            controller.enqueue({ type: 'error', error: chunk.error });
            return;
          }

          const value = chunk.value;

          if (value.usage) {
            inputTokens = value.usage.prompt_tokens ?? undefined;
            outputTokens = value.usage.completion_tokens ?? undefined;
          }

          for (const choice of value.choices) {
            const delta = choice.delta;

            if (delta.content) {
              // V2 text streaming: text-start → text-delta → text-end
              const textId = 'text-0';
              if (!openTextIds.has(textId)) {
                openTextIds.add(textId);
                controller.enqueue({ type: 'text-start', id: textId });
              }
              controller.enqueue({
                type: 'text-delta',
                id: textId,
                delta: delta.content,
              });
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index;

                if (!toolCallAccumulators.has(idx)) {
                  const toolCallId = tc.id ?? generateIdFn();
                  toolCallAccumulators.set(idx, {
                    id: toolCallId,
                    name: tc.function?.name ?? '',
                    argumentsText: tc.function?.arguments ?? '',
                  });
                  // V2 tool streaming: tool-input-start → tool-input-delta → tool-input-end → tool-call
                  controller.enqueue({
                    type: 'tool-input-start',
                    id: toolCallId,
                    toolName: tc.function?.name ?? '',
                  });
                  if (tc.function?.arguments) {
                    controller.enqueue({
                      type: 'tool-input-delta',
                      id: toolCallId,
                      delta: tc.function.arguments,
                    });
                  }
                } else {
                  const acc = toolCallAccumulators.get(idx)!;
                  const argsDelta = tc.function?.arguments ?? '';
                  acc.argumentsText += argsDelta;
                  if (argsDelta) {
                    controller.enqueue({
                      type: 'tool-input-delta',
                      id: acc.id,
                      delta: argsDelta,
                    });
                  }
                }
              }
            }

            if (choice.finish_reason != null) {
              finishReason = mapFinishReason(choice.finish_reason);
            }
          }
        },

        flush(controller) {
          // Close open text streams
          for (const textId of openTextIds) {
            controller.enqueue({ type: 'text-end', id: textId });
          }

          // Emit completed tool calls
          for (const acc of toolCallAccumulators.values()) {
            controller.enqueue({ type: 'tool-input-end', id: acc.id });
            controller.enqueue({
              type: 'tool-call',
              toolCallId: acc.id,
              toolName: acc.name,
              input: acc.argumentsText,
            });
          }

          controller.enqueue({
            type: 'finish',
            finishReason,
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: undefined,
            },
          });
        },
      }),
    );

    return {
      stream: coreStream,
      request: { body },
      response: {
        headers: streamResponseHeaders,
      },
    };
  }
}

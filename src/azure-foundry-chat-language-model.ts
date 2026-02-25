import {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1CallWarning,
  LanguageModelV1FinishReason,
  LanguageModelV1FunctionToolCall,
  LanguageModelV1Message,
  LanguageModelV1StreamPart,
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
   * Called once per request so the URL can encode the model in the path
   * (Azure OpenAI / cognitiveservices style) or use a shared endpoint
   * (AI Foundry inference style, model sent in request body).
   */
  url: (modelId: string) => string;
  /**
   * When true, the model ID is sent in the request body as `model`.
   * Used for AI Foundry inference endpoints (services.ai.azure.com/models).
   * Azure OpenAI endpoints encode the model in the URL path instead.
   */
  modelInBody: boolean;
  /**
   * Returns Bearer token headers for every request. Async because Azure
   * identity credential.getToken() is async.
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

function mapFinishReason(reason: string | null | undefined): LanguageModelV1FinishReason {
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

function convertToAzureMessages(prompt: LanguageModelV1Message[]): ChatMessage[] {
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
          switch (part.type) {
            case 'text':
              parts.push({ type: 'text', text: part.text });
              break;
            case 'image': {
              const image = part.image;
              if (image instanceof URL) {
                parts.push({
                  type: 'image_url',
                  image_url: { url: image.href },
                });
              } else {
                // Uint8Array → base64 data URL
                const b64 = Buffer.from(image).toString('base64');
                const mime = part.mimeType ?? 'image/jpeg';
                parts.push({
                  type: 'image_url',
                  image_url: { url: `data:${mime};base64,${b64}` },
                });
              }
              break;
            }
            case 'file':
              // Files are not natively supported; skip with a warning handled
              // in getArgs.
              break;
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
                  arguments: typeof part.args === 'string'
                    ? part.args
                    : JSON.stringify(part.args),
                },
              });
              break;
            // reasoning / redacted-reasoning: skip
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
            content:
              typeof part.result === 'string'
                ? part.result
                : JSON.stringify(part.result),
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

export class AzureFoundryChatLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1' as const;
  readonly defaultObjectGenerationMode = 'json' as const;

  readonly modelId: AzureFoundryChatModelId;

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

  private getArgs(options: LanguageModelV1CallOptions) {
    const warnings: LanguageModelV1CallWarning[] = [];

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

    // Tool setup
    let tools: unknown;
    let tool_choice: unknown;

    if (options.mode.type === 'regular') {
      if (options.mode.tools && options.mode.tools.length > 0) {
        tools = options.mode.tools
          .filter((t) => t.type === 'function')
          .map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }));
      }

      if (options.mode.toolChoice) {
        const tc = options.mode.toolChoice;
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
    } else if (options.mode.type === 'object-json') {
      // Instruct the model to respond with JSON
      // We don't set response_format here because Azure AI Foundry
      // may not support it for all models.
      messages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Respond with a valid JSON object only. Do not include any markdown formatting or additional text.',
          },
        ],
      });
    } else if (options.mode.type === 'object-tool') {
      tools = [
        {
          type: 'function',
          function: {
            name: options.mode.tool.name,
            description: options.mode.tool.description,
            parameters: options.mode.tool.parameters,
          },
        },
      ];
      tool_choice = {
        type: 'function',
        function: { name: options.mode.tool.name },
      };
    }

    // Only include temperature / top_p when they are explicitly configured.
    // The Vercel AI SDK passes temperature=0 as its default, but some models
    // (e.g. gpt-5-nano) only accept the server-side default (1) and reject 0.
    // By omitting these fields we let the model use its own defaults.
    const explicitTemperature = this.settings.temperature ?? (options.temperature !== 0 ? options.temperature : undefined);
    const explicitTopP = this.settings.topP ?? (options.topP !== 0 ? options.topP : undefined);

    const body: Record<string, unknown> = {
      ...(this.config.modelInBody ? { model: this.modelId } : {}),
      messages,
      max_tokens: options.maxTokens ?? this.settings.maxTokens,
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

  async doGenerate(options: LanguageModelV1CallOptions): Promise<Awaited<ReturnType<LanguageModelV1['doGenerate']>>> {
    const { body, warnings } = this.getArgs(options);
    const headers = await this.config.headers();

    const { value: response, responseHeaders } = await postJsonToApi({
      url: this.config.url(this.modelId),
      headers: combineHeaders(
        headers,
        options.headers,
        { 'x-ms-useragent': `@nquandt/azure-ai-sdk/${VERSION}` },
      ),
      body,
      failedResponseHandler: azureFoundryFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(chatResponseSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });

    const choice = response.choices[0];
    const message = choice?.message;

    const text = message?.content ?? undefined;

    const toolCalls: LanguageModelV1FunctionToolCall[] | undefined =
      message?.tool_calls && message.tool_calls.length > 0
        ? message.tool_calls.map((tc) => ({
            toolCallType: 'function' as const,
            toolCallId: tc.id,
            toolName: tc.function.name,
            args: tc.function.arguments,
          }))
        : undefined;

    return {
      text,
      toolCalls,
      finishReason: mapFinishReason(choice?.finish_reason),
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
      },
      rawCall: {
        rawPrompt: body,
        rawSettings: {},
      },
      rawResponse: {
        headers: responseHeaders,
      },
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // doStream
  // -------------------------------------------------------------------------

  async doStream(options: LanguageModelV1CallOptions): Promise<Awaited<ReturnType<LanguageModelV1['doStream']>>> {
    const { body, warnings } = this.getArgs(options);
    const headers = await this.config.headers();

    const { value: stream, responseHeaders: streamResponseHeaders } = await postJsonToApi({
      url: this.config.url(this.modelId),
      headers: combineHeaders(
        headers,
        options.headers,
        { 'x-ms-useragent': `@nquandt/azure-ai-sdk/${VERSION}` },
      ),
      body: { ...body, stream: true },
      failedResponseHandler: azureFoundryFailedResponseHandler,
      successfulResponseHandler: createEventSourceResponseHandler(chatChunkSchema),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });

    let finishReason: LanguageModelV1FinishReason = 'other';
    let promptTokens = 0;
    let completionTokens = 0;

    // Track streaming tool calls (assembled across multiple deltas)
    const toolCallAccumulators: Map<
      number,
      { id: string; name: string; argumentsText: string }
    > = new Map();

    const generateIdFn = this._generateId;

    return {
      stream: stream.pipeThrough(
        new TransformStream<
          ParseResult<z.infer<typeof chatChunkSchema>>,
          LanguageModelV1StreamPart
        >({
          transform(chunk, controller) {
            if (!chunk.success) {
              controller.enqueue({ type: 'error', error: chunk.error });
              return;
            }

            const value = chunk.value;

            if (value.usage) {
              promptTokens = value.usage.prompt_tokens ?? 0;
              completionTokens = value.usage.completion_tokens ?? 0;
            }

            for (const choice of value.choices) {
              const delta = choice.delta;

              // Text delta
              if (delta.content) {
                controller.enqueue({
                  type: 'text-delta',
                  textDelta: delta.content,
                });
              }

              // Tool call deltas
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index;

                  if (!toolCallAccumulators.has(idx)) {
                    // First delta for this tool call
                    const toolCallId = tc.id ?? generateIdFn();
                    toolCallAccumulators.set(idx, {
                      id: toolCallId,
                      name: tc.function?.name ?? '',
                      argumentsText: tc.function?.arguments ?? '',
                    });
                    controller.enqueue({
                      type: 'tool-call-delta',
                      toolCallType: 'function',
                      toolCallId,
                      toolName: tc.function?.name ?? '',
                      argsTextDelta: tc.function?.arguments ?? '',
                    });
                  } else {
                    // Subsequent delta — accumulate arguments
                    const acc = toolCallAccumulators.get(idx)!;
                    const argsDelta = tc.function?.arguments ?? '';
                    acc.argumentsText += argsDelta;
                    controller.enqueue({
                      type: 'tool-call-delta',
                      toolCallType: 'function',
                      toolCallId: acc.id,
                      toolName: acc.name,
                      argsTextDelta: argsDelta,
                    });
                  }
                }
              }

              if (choice.finish_reason != null) {
                finishReason = mapFinishReason(choice.finish_reason);
              }
            }
          },

          flush(controller) {
            // Emit completed tool calls
            for (const acc of toolCallAccumulators.values()) {
              controller.enqueue({
                type: 'tool-call',
                toolCallType: 'function',
                toolCallId: acc.id,
                toolName: acc.name,
                args: acc.argumentsText,
              });
            }

            controller.enqueue({
              type: 'finish',
              finishReason,
              usage: {
                promptTokens,
                completionTokens,
              },
            });
          },
        }),
      ),
      rawCall: {
        rawPrompt: body,
        rawSettings: {},
      },
      rawResponse: {
        headers: streamResponseHeaders,
      },
      warnings,
    };
  }
}

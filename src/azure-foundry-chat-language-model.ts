import {
  LanguageModelV2,
  LanguageModelV2CallOptions,
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
import { resolveAdapter, ChatAdapter } from './adapters/index.js';
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
// Language model implementation
// ---------------------------------------------------------------------------

export class AzureFoundryChatLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;

  readonly modelId: AzureFoundryChatModelId;

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
  // doGenerate
  // -------------------------------------------------------------------------

  async doGenerate(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2['doGenerate']>>> {
    const adapter = resolveAdapter(
      this.modelId,
      this.settings.adapterType,
      this._generateId,
    );

    const { body, warnings } = adapter.buildRequest(
      options,
      this.modelId,
      this.config.modelInBody,
    );

    const headers = await this.config.headers();

    const { value: response, responseHeaders } = await postJsonToApi({
      url: this.config.url(this.modelId),
      headers: combineHeaders(headers, options.headers, {
        'x-ms-useragent': `@nquandt/azure-ai-sdk/${VERSION}`,
      }),
      body,
      failedResponseHandler: azureFoundryFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(
        adapter.responseSchema as z.ZodType<unknown>,
      ),
      abortSignal: options.abortSignal,
      fetch: this.config.fetch,
    });

    const parsed = adapter.parseResponse(response);

    return {
      content: parsed.content,
      finishReason: parsed.finishReason,
      usage: parsed.usage,
      warnings,
      request: { body },
      response: { headers: responseHeaders },
    };
  }

  // -------------------------------------------------------------------------
  // doStream
  // -------------------------------------------------------------------------

  async doStream(
    options: LanguageModelV2CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV2['doStream']>>> {
    const adapter = resolveAdapter(
      this.modelId,
      this.settings.adapterType,
      this._generateId,
    );

    const { body, warnings } = adapter.buildRequest(
      options,
      this.modelId,
      this.config.modelInBody,
    );

    const headers = await this.config.headers();

    const { value: stream, responseHeaders: streamResponseHeaders } =
      await postJsonToApi({
        url: this.config.url(this.modelId),
        headers: combineHeaders(headers, options.headers, {
          'x-ms-useragent': `@nquandt/azure-ai-sdk/${VERSION}`,
        }),
        body: { ...body, stream: true },
        failedResponseHandler: azureFoundryFailedResponseHandler,
        successfulResponseHandler: createEventSourceResponseHandler(
          adapter.chunkSchema as z.ZodType<unknown>,
        ),
        abortSignal: options.abortSignal,
        fetch: this.config.fetch,
      });

    const streamStartPart: LanguageModelV2StreamPart = {
      type: 'stream-start',
      warnings,
    };

    const coreStream = stream.pipeThrough(
      new TransformStream<ParseResult<unknown>, LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue(streamStartPart);
        },

        transform(chunk, controller) {
          for (const part of adapter.parseChunk(chunk)) {
            controller.enqueue(part as LanguageModelV2StreamPart);
          }
        },

        flush(controller) {
          for (const part of adapter.flush()) {
            controller.enqueue(part as LanguageModelV2StreamPart);
          }
        },
      }),
    );

    return {
      stream: coreStream,
      request: { body },
      response: { headers: streamResponseHeaders },
    };
  }
}

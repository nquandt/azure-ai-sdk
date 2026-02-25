import type { AdapterType } from './adapters/index.js';

export type AzureFoundryChatModelId = string;

export interface AzureFoundryChatSettings {
  /**
   * Controls which request/response payload format is used.
   *
   * - `'openai'`        — OpenAI chat completions v2 style: `max_completion_tokens`,
   *                       temperature=0 suppressed. For o-series, gpt-5+.
   * - `'openai-legacy'` — OpenAI chat completions v1 style: `max_tokens`,
   *                       temperature forwarded as-is. For gpt-4o, gpt-4, gpt-35-turbo.
   * - `'anthropic'`     — Anthropic Messages API format. For Claude models
   *                       served via Azure AI Foundry or an identity gateway.
   *
   * When omitted, the adapter is inferred from the model ID using known
   * naming patterns. Explicit always wins — set this when deploying behind
   * APIM or another gateway where the deployment name doesn't match the
   * underlying model family.
   */
  adapterType?: AdapterType;

  /**
   * Maximum number of tokens to generate in the response.
   */
  maxTokens?: number;

  /**
   * Sampling temperature. Higher values make output more random.
   * Range: 0-2.
   */
  temperature?: number;

  /**
   * Top-p nucleus sampling. Alternative to temperature.
   */
  topP?: number;
}

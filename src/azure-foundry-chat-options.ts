export type AzureFoundryChatModelId = string;

export interface AzureFoundryChatSettings {
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

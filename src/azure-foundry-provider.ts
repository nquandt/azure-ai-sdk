import { LanguageModelV1, NoSuchModelError, ProviderV1 } from '@ai-sdk/provider';
import { FetchFunction, withoutTrailingSlash } from '@ai-sdk/provider-utils';
import {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  TokenCredential,
  WorkloadIdentityCredential,
  getBearerTokenProvider,
} from '@azure/identity';
import {
  AzureFoundryChatLanguageModel,
} from './azure-foundry-chat-language-model.js';
import {
  AzureFoundryChatModelId,
  AzureFoundryChatSettings,
} from './azure-foundry-chat-options.js';

// ---------------------------------------------------------------------------
// Scope used to obtain tokens for Azure AI Foundry / Azure ML endpoints
// ---------------------------------------------------------------------------
const AZURE_AI_SCOPE = 'https://cognitiveservices.azure.com/.default';

// ---------------------------------------------------------------------------
// Provider settings
// ---------------------------------------------------------------------------

export interface AzureFoundryProviderSettings {
  /**
   * Azure resource base URL. Two formats are supported:
   *
   * Azure OpenAI / Cognitive Services (cognitiveservices.azure.com):
   *   https://<resource>.cognitiveservices.azure.com
   *   → calls /openai/deployments/{model}/chat/completions?api-version=...
   *
   * AI Foundry inference (services.ai.azure.com):
   *   https://<project>.services.ai.azure.com/models
   *   → calls /chat/completions with model in the request body
   *
   * Can also be provided via the AZURE_AI_FOUNDRY_ENDPOINT environment variable.
   */
  endpoint?: string;

  /**
   * API version query parameter appended to every request.
   * Only relevant for cognitiveservices.azure.com endpoints.
   * Defaults to '2024-10-21'.
   */
  apiVersion?: string;

  /**
   * Azure token credential to use for authentication.
   * Defaults to DefaultAzureCredential which supports:
   *   - Environment variables (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)
   *   - Workload identity (Kubernetes)
   *   - Managed identity (Azure-hosted compute)
   *   - Azure CLI (`az login`)
   *   - Azure PowerShell
   *   - Visual Studio Code
   *
   * You can pass any `TokenCredential` from `@azure/identity`, for example:
   *   - new ClientSecretCredential(tenantId, clientId, clientSecret)
   *   - new ManagedIdentityCredential(clientId)
   *   - new WorkloadIdentityCredential()
   */
  credential?: TokenCredential;

  /**
   * OAuth2 scope to request.
   * Defaults to 'https://cognitiveservices.azure.com/.default'.
   */
  scope?: string;

  /**
   * Custom headers to include in every request.
   */
  headers?: Record<string, string>;

  /**
   * Custom fetch implementation. Useful for testing / middleware.
   */
  fetch?: FetchFunction;

  generateId?: () => string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface AzureFoundryProvider extends ProviderV1 {
  /**
   * Create a language model instance for the given deployment name.
   */
  (
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV1;

  /**
   * Create a language model instance for the given deployment name.
   */
  languageModel(
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV1;

  /**
   * Create a chat model instance for the given deployment name.
   */
  chat(
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV1;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an Azure AI Foundry provider instance.
 *
 * Authentication is handled via Azure Identity. The credential is resolved
 * in the following order (when no `credential` is specified):
 *
 * 1. `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` / `AZURE_TENANT_ID` env vars
 * 2. Workload identity (Kubernetes pods with federated credentials)
 * 3. Managed identity (Azure-hosted compute)
 * 4. Azure CLI (`az login`)
 * 5. Azure PowerShell
 * 6. VS Code account
 *
 * @example
 * ```ts
 * import { createAzureFoundry } from '@nquandt/azure-ai-sdk';
 * import { generateText } from 'ai';
 *
 * // Azure OpenAI / Cognitive Services endpoint:
 * const foundry = createAzureFoundry({
 *   endpoint: 'https://my-resource.cognitiveservices.azure.com',
 * });
 *
 * // AI Foundry inference endpoint:
 * const foundry = createAzureFoundry({
 *   endpoint: 'https://my-project.services.ai.azure.com/models',
 * });
 *
 * const { text } = await generateText({
 *   model: foundry('DeepSeek-R1'),
 *   prompt: 'Hello world',
 * });
 * ```
 */
export function createAzureFoundry(
  options: AzureFoundryProviderSettings = {},
): AzureFoundryProvider {
  const endpoint =
    withoutTrailingSlash(
      options.endpoint ??
        (typeof process !== 'undefined'
          ? process.env.AZURE_AI_FOUNDRY_ENDPOINT
          : undefined),
    ) ?? '';

  if (!endpoint) {
    throw new Error(
      '@nquandt/azure-ai-sdk: An Azure AI Foundry endpoint is required. ' +
        'Provide it via the `endpoint` option or the AZURE_AI_FOUNDRY_ENDPOINT environment variable.',
    );
  }

  const credential: TokenCredential =
    options.credential ?? new DefaultAzureCredential();

  const scope = options.scope ?? AZURE_AI_SCOPE;

  // getToken is cached and auto-refreshed by the Azure SDK
  const getToken = getBearerTokenProvider(credential, scope);

  const getHeaders = async (): Promise<Record<string, string>> => {
    const token = await getToken();
    return {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    };
  };

  // Detect endpoint style and build the appropriate chat completions URL.
  //
  // cognitiveservices.azure.com  →  Azure OpenAI deployment-path style:
  //   {endpoint}/openai/deployments/{modelId}/chat/completions?api-version=...
  //
  // services.ai.azure.com/models →  AI Foundry inference style:
  //   {endpoint}/chat/completions   (model sent in request body)
  //
  const isCognitiveServices = endpoint.includes('cognitiveservices.azure.com');
  const apiVersion = options.apiVersion ?? '2024-10-21';

  const buildUrl = (modelId: string): string => {
    if (isCognitiveServices) {
      return `${endpoint}/openai/deployments/${encodeURIComponent(modelId)}/chat/completions?api-version=${apiVersion}`;
    }
    return `${endpoint}/chat/completions`;
  };

  const createChatModel = (
    modelId: AzureFoundryChatModelId,
    settings: AzureFoundryChatSettings = {},
  ) =>
    new AzureFoundryChatLanguageModel(modelId, settings, {
      provider: 'azure-foundry.chat',
      url: buildUrl,
      modelInBody: !isCognitiveServices,
      headers: getHeaders,
      fetch: options.fetch,
      generateId: options.generateId,
    });

  const provider = function (
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ) {
    if (new.target) {
      throw new Error(
        'The AzureFoundry model function cannot be called with the new keyword.',
      );
    }
    return createChatModel(modelId, settings);
  };

  provider.languageModel = createChatModel;
  provider.chat = createChatModel;

  provider.textEmbeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'textEmbeddingModel' });
  };

  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
  };

  return provider as AzureFoundryProvider;
}

// ---------------------------------------------------------------------------
// Convenience exports for well-known credential types
// ---------------------------------------------------------------------------

export {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
};

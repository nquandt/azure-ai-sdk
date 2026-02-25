import { LanguageModelV2, NoSuchModelError, ProviderV2 } from '@ai-sdk/provider';
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
   * Controls how the chat completions URL is constructed.
   *
   * - `'auto'` (default) — infer from the hostname:
   *     `cognitiveservices.azure.com` → `'cognitive-services'`
   *     all others                   → `'foundry'`
   * - `'cognitive-services'` — Azure OpenAI deployment-path style:
   *     `{endpoint}/openai/deployments/{model}/chat/completions?api-version=...`
   *     Model is placed in the URL path; `api-version` query param is appended.
   * - `'foundry'` — AI Foundry inference style:
   *     `{endpoint}/chat/completions`  (model sent in request body)
   *
   * Set this explicitly when routing through a gateway (e.g. APIM) whose
   * hostname does not contain `cognitiveservices.azure.com` but whose backend
   * expects the deployment-path URL format.
   *
   * @example
   * ```ts
   * // APIM gateway fronting an Azure OpenAI backend
   * createAzureFoundry({
   *   endpoint: 'https://my-org.azure-api.net',
   *   endpointStyle: 'cognitive-services',
   * });
   * ```
   */
  endpointStyle?: 'auto' | 'cognitive-services' | 'foundry';

  /**
   * API version query parameter appended to every request.
   * Only relevant for the `'cognitive-services'` endpoint style.
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
   */
  credential?: TokenCredential;

  /**
   * OAuth2 scope to request when obtaining a bearer token.
   *
   * Defaults to `'https://cognitiveservices.azure.com/.default'`, which is
   * correct for direct Cognitive Services and AI Foundry endpoints.
   *
   * When routing through Azure API Management (APIM), set this to the scope
   * of the APIM's Entra app registration:
   *   `'api://<apim-app-client-id>/.default'`
   *
   * The APIM instance must be configured to validate JWT tokens from this
   * audience and forward requests to the backend on behalf of the caller.
   */
  scope?: string;

  /**
   * Optional supplemental API key sent alongside the Entra bearer token.
   *
   * **Entra identity is the primary and preferred authentication mechanism
   * for this provider.** This option exists solely for APIM deployments that
   * require a subscription key *in addition to* a valid Entra token — it is
   * not a substitute for Entra auth and the bearer token is always sent.
   *
   * When set, the value is forwarded as:
   *   - `Ocp-Apim-Subscription-Key` (APIM subscription key header)
   *   - `api-key` (Azure OpenAI / Cognitive Services compatibility header)
   *
   * Values in `headers` take precedence if the same key appears in both.
   *
   * @example
   * ```ts
   * // APIM policy requires both an Entra token AND a subscription key
   * createAzureFoundry({
   *   endpoint: 'https://my-org.azure-api.net',
   *   endpointStyle: 'cognitive-services',
   *   scope: 'api://<apim-app-client-id>/.default',
   *   apiKey: process.env.APIM_SUBSCRIPTION_KEY,
   * });
   * ```
   */
  apiKey?: string;

  /**
   * Custom headers to include in every request.
   * These take precedence over any headers set by `apiKey`.
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

export interface AzureFoundryProvider extends ProviderV2 {
  /**
   * Create a language model instance for the given deployment name.
   */
  (
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV2;

  /**
   * Create a language model instance for the given deployment name.
   */
  languageModel(
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV2;

  /**
   * Create a chat model instance for the given deployment name.
   */
  chat(
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV2;
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
      ...(options.apiKey
        ? {
            'Ocp-Apim-Subscription-Key': options.apiKey,
            'api-key': options.apiKey,
          }
        : {}),
      // Explicit headers always win — they are merged last
      ...options.headers,
    };
  };

  // Resolve the endpoint style.
  //
  // 'auto' (default) — infer from hostname:
  //   cognitiveservices.azure.com  →  'cognitive-services'
  //   anything else                →  'foundry'
  //
  // Callers may override with an explicit 'endpointStyle' to handle gateways
  // (e.g. APIM) whose hostname does not match the backend's hostname pattern.
  //
  const resolvedStyle = ((): 'cognitive-services' | 'foundry' => {
    const style = options.endpointStyle ?? 'auto';
    if (style === 'cognitive-services') return 'cognitive-services';
    if (style === 'foundry') return 'foundry';
    // 'auto' — sniff hostname
    return endpoint.includes('cognitiveservices.azure.com')
      ? 'cognitive-services'
      : 'foundry';
  })();

  const isCognitiveServices = resolvedStyle === 'cognitive-services';
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

  return provider as unknown as AzureFoundryProvider;
}

// ---------------------------------------------------------------------------
// Convenience exports for well-known credential types
// ---------------------------------------------------------------------------

export {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
};

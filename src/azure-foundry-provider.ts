import { LanguageModelV3, NoSuchModelError, ProviderV3 } from '@ai-sdk/provider';
import { FetchFunction, withoutTrailingSlash } from '@ai-sdk/provider-utils';
import type { TokenCredential } from '@azure/identity';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
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
const COGNITIVE_SERVICES_SCOPE = 'https://cognitiveservices.azure.com/.default';
const AI_FOUNDRY_SCOPE = 'https://ai.azure.com/.default';

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
   *
   * Alternatively, provide `resourceName` (and optionally `projectId`) to have
   * the endpoint constructed automatically.
   */
  endpoint?: string;

  /**
   * Azure AI Foundry resource name (the subdomain portion of the hostname).
   *
   * Constructs: https://{resourceName}.services.ai.azure.com/models
   *
   * `projectId` may be provided alongside this for configuration purposes but
   * does not change the URL — the `/models` endpoint serves all deployed models.
   *
   * Takes precedence over `endpoint` when both are set.
   * Can also be provided via the AZURE_FOUNDRY_RESOURCE environment variable.
   */
  resourceName?: string;

  /**
   * Azure AI Foundry project name.
   * Accepted as a configuration convenience but does not affect the URL —
   * the provider always uses the resource-level `/models` inference endpoint,
   * which works for all deployed models regardless of project scoping.
   * Can also be provided via the AZURE_FOUNDRY_PROJECT environment variable.
   */
  projectId?: string;

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
   * The default scope is inferred from the endpoint:
   *   - `*.services.ai.azure.com` → `'https://ai.azure.com/.default'`
   *   - all other endpoints       → `'https://cognitiveservices.azure.com/.default'`
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
   * Direct API key for Azure AI Foundry endpoints.
   *
   * When set, this value is used directly as the Bearer token and **Entra
   * identity is bypassed entirely**. This is convenient for local testing or
   * environments where `az login` is not available.
   *
   * For production workloads prefer leaving this unset and relying on
   * `DefaultAzureCredential` (managed identity, workload identity, etc.).
   *
   * Can also be provided via the `AZURE_FOUNDRY_API_KEY` environment variable.
   *
   * @example
   * ```ts
   * // Quick local test without az login
   * createAzureFoundry({
   *   resourceName: 'my-resource',
   *   projectId: 'my-project',
   *   apiKey: process.env.AZURE_FOUNDRY_API_KEY,
   * });
   * ```
   */
  apiKey?: string;

  /**
   * APIM subscription key sent **alongside** the Entra bearer token.
   *
   * Use this when routing through Azure API Management that requires a
   * subscription key in addition to a valid Entra JWT. The Entra bearer token
   * is always obtained and sent; this key is forwarded as supplemental headers:
   *   - `Ocp-Apim-Subscription-Key`
   *   - `api-key`
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
   *   subscriptionKey: process.env.APIM_SUBSCRIPTION_KEY,
   * });
   * ```
   */
  subscriptionKey?: string;

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

  /**
   * Logger for diagnostic output. Defaults to `console`.
   *
   * Set to `null` to silence all SDK logging. You can also supply a custom
   * object with `{ error, warn, info }` methods to route logs to your own
   * logging infrastructure.
   *
   * @example
   * // Silence logging
   * createAzureFoundry({ ..., logger: null });
   *
   * @example
   * // Route to a custom logger
   * createAzureFoundry({ ..., logger: myLogger });
   */
  logger?: Pick<Console, 'error' | 'warn' | 'info'> | null;

  /**
   * Path to a file where debug log lines are appended.
   *
   * When set, key lifecycle events (init, token acquisition, errors) are
   * written to this file in addition to the normal `logger`. Useful when
   * the host process (e.g. opencode) does not surface provider console output.
   *
   * The `AZURE_AI_SDK_DEBUG` environment variable is an alternative: when
   * truthy, debug output is written to `<os.tmpdir()>/azure-ai-sdk-debug.log`.
   * The `debugLogFile` option takes precedence when both are set.
   *
   * @example
   * // In opencode.json options:
   * { "debugLogFile": "/tmp/azure-ai-sdk-debug.log" }
   */
  debugLogFile?: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface AzureFoundryProvider extends ProviderV3 {
  /**
   * Create a language model instance for the given deployment name.
   */
  (
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV3;

  /**
   * Create a language model instance for the given deployment name.
   */
  languageModel(
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV3;

  /**
   * Create a chat model instance for the given deployment name.
   */
  chat(
    modelId: AzureFoundryChatModelId,
    settings?: AzureFoundryChatSettings,
  ): LanguageModelV3;
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
  // ---------------------------------------------------------------------------
  // Debug file logger — activated by `debugLogFile` option or the
  // AZURE_AI_SDK_DEBUG env var.  Writes timestamped lines to a file so that
  // errors are visible even when the host process (e.g. opencode) suppresses
  // console output.
  // ---------------------------------------------------------------------------
  const debugFilePath: string | undefined =
    options.debugLogFile ??
    (typeof process !== 'undefined' && process.env.AZURE_AI_SDK_DEBUG
      ? (process.env.AZURE_AI_SDK_DEBUG_LOG ?? `${tmpdir()}/azure-ai-sdk-debug.log`)
      : undefined);

  function debugLog(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
    if (!debugFilePath) return;
    try {
      mkdirSync(dirname(debugFilePath), { recursive: true });
      // Overwrite on the first call each process run, append thereafter.
      if (debugLog.firstWrite) {
        debugLog.firstWrite = false;
        writeFileSync(debugFilePath, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
      } else {
        appendFileSync(debugFilePath, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
      }
    } catch {
      // never let debug logging break the provider
    }
  }
  debugLog.firstWrite = true;

  debugLog('INFO', `createAzureFoundry called — options: ${JSON.stringify({
    hasResourceName: !!options.resourceName,
    hasEndpoint: !!options.endpoint,
    hasApiKey: !!options.apiKey,
    hasCredential: !!options.credential,
    hasScope: !!options.scope,
    endpointStyle: options.endpointStyle,
    apiVersion: options.apiVersion,
  })}`);

  // ---------------------------------------------------------------------------
  // Endpoint resolution (priority order):
  //   1. options.resourceName (+ options.projectId) — explicit code-level names
  //   2. options.endpoint                           — explicit code-level URL
  //   3. AZURE_FOUNDRY_RESOURCE env var (+ AZURE_FOUNDRY_PROJECT) — env-based names
  //   4. AZURE_AI_FOUNDRY_ENDPOINT env var          — env-based full URL
  //
  // Explicit code-level options always win over env vars so that unit tests
  // which pass a specific endpoint are never overridden by a .env file.
  // ---------------------------------------------------------------------------
  const resolvedEndpoint = (() => {
    if (options.resourceName) {
      // projectId is accepted as a config convenience but does not change the URL.
      // The /models endpoint is the known-working inference surface for all models.
      return `https://${options.resourceName}.services.ai.azure.com/models`;
    }
    if (options.endpoint !== undefined) return options.endpoint;
    const envResource = typeof process !== 'undefined' ? process.env.AZURE_FOUNDRY_RESOURCE : undefined;
    if (envResource) {
      return `https://${envResource}.services.ai.azure.com/models`;
    }
    return typeof process !== 'undefined' ? process.env.AZURE_AI_FOUNDRY_ENDPOINT : undefined;
  })();

  const endpoint = withoutTrailingSlash(resolvedEndpoint) ?? '';

  if (!endpoint) {
    const err = '@nquandt/azure-ai-sdk: An Azure AI Foundry endpoint is required. ' +
      'Provide it via `resourceName`/`projectId`, the `endpoint` option, or the AZURE_AI_FOUNDRY_ENDPOINT environment variable.';
    debugLog('ERROR', err);
    throw new Error(err);
  }

  debugLog('INFO', `endpoint resolved — url=${endpoint}`);

  // ---------------------------------------------------------------------------
  // API key resolution:
  //   - options.apiKey wins if provided
  //   - If options.credential is explicitly set, the caller wants Entra auth;
  //     do NOT fall back to AZURE_FOUNDRY_API_KEY env var.
  //   - Otherwise, read AZURE_FOUNDRY_API_KEY from env as a convenience for
  //     testing without az login.
  // ---------------------------------------------------------------------------
  const apiKey =
    options.apiKey ??
    (options.credential
      ? undefined
      : (typeof process !== 'undefined' ? process.env.AZURE_FOUNDRY_API_KEY : undefined));

  // When an explicit API key is provided, use it directly as the Bearer token
  // and skip Entra identity entirely. This is useful for local testing without
  // requiring `az login`. For production, prefer credential-based auth.

  // null explicitly disables logging; undefined falls back to console.
  const logger = options.logger === null ? null : (options.logger ?? console);

  const getHeaders: () => Promise<Record<string, string>> = apiKey
    ? (() => {
        debugLog('INFO', 'auth=apiKey (Entra bypassed)');
        return async () => ({
          Authorization: `Bearer ${apiKey}`,
          ...options.headers,
        });
      })()
    : (() => {
        // Lazily import @azure/identity only when Entra auth is actually needed.
        // This avoids loading native Azure SDK modules in environments (e.g. bun)
        // where they may not be available, when an apiKey is being used instead.
        let getTokenFn: (() => Promise<string>) | undefined;
        const defaultScope = endpoint.includes('services.ai.azure.com')
          ? AI_FOUNDRY_SCOPE
          : COGNITIVE_SERVICES_SCOPE;
        const scope = options.scope ?? defaultScope;
        const credentialType = options.credential
          ? options.credential.constructor?.name ?? 'custom'
          : 'DefaultAzureCredential';
        return async () => {
          if (!getTokenFn) {
            debugLog('INFO', `acquiring Entra token — scope=${scope} credentialType=${credentialType}`);
            const { DefaultAzureCredential, getBearerTokenProvider } = await import('@azure/identity');
            const credential: TokenCredential =
              options.credential ?? new DefaultAzureCredential();
            getTokenFn = getBearerTokenProvider(credential, scope);
          }
          try {
            const token = await getTokenFn();
            debugLog('INFO', 'Entra token acquired successfully');
            return {
              Authorization: `Bearer ${token}`,
              // APIM subscription key — sent alongside the Entra token when set
              ...(options.subscriptionKey
                ? {
                    'Ocp-Apim-Subscription-Key': options.subscriptionKey,
                    'api-key': options.subscriptionKey,
                  }
                : {}),
              // Explicit headers always win — they are merged last
              ...options.headers,
            };
          } catch (err) {
            const cause = err instanceof Error ? err.message : String(err);
            const msg = `[azure-ai-sdk] Failed to acquire Azure token — endpoint=${endpoint} scope=${scope} credentialType=${credentialType} cause=${cause}`;
            debugLog('ERROR', msg);
            logger?.error(msg);
            throw new Error(msg, { cause: err instanceof Error ? err : undefined });
          }
        };
      })();

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

  const buildUrl = (modelId: string, urlSuffix = '/chat/completions'): string => {
    if (isCognitiveServices) {
      // Strip a trailing `/openai` that callers may have included in the endpoint.
      // We always append `/openai/deployments/...` ourselves, so including it in
      // the endpoint would produce a doubled path segment:
      //   https://my-org.azure-api.net/openai/openai/deployments/...  ← wrong
      //   https://my-org.azure-api.net/openai/deployments/...         ← correct
      const base = endpoint.replace(/\/openai\/?$/i, '');
      // For non-standard paths (e.g. Anthropic's /anthropic/v1/messages)
      // don't wrap in the OpenAI deployment path structure
      if (urlSuffix !== '/chat/completions') {
        return `${base}${urlSuffix}`;
      }
      return `${base}/openai/deployments/${encodeURIComponent(modelId)}/chat/completions?api-version=${apiVersion}`;
    }
    return `${endpoint}${urlSuffix}`;
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
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };

  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
  };

  debugLog('INFO', `provider created — endpoint=${endpoint} style=${resolvedStyle}`);
  return provider as unknown as AzureFoundryProvider;
}

// Credential classes are no longer re-exported from this module.
// Import them directly from '@azure/identity' when needed.

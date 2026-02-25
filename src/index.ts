// =============================================================================
// @nquandt/azure-ai-sdk
//
// Vercel AI SDK custom provider for Azure AI Foundry using Entra authentication.
// =============================================================================

// ---------------------------------------------------------------------------
// Primary entrypoint — everything a consumer needs is re-exported here.
// ---------------------------------------------------------------------------

// -- Provider factory --------------------------------------------------------
// `createAzureFoundry` is the main entrypoint. Call it with your endpoint
// (and optionally a credential) to get a provider instance:
//
//   const foundry = createAzureFoundry({ endpoint: '...' });
//   const model   = foundry('DeepSeek-R1');               // LanguageModelV1
//   const model   = foundry.chat('DeepSeek-R1');           // same, explicit
//   const model   = foundry.languageModel('DeepSeek-R1'); // same, via ProviderV1
//
export { createAzureFoundry } from './azure-foundry-provider.js';
export type { AzureFoundryProvider, AzureFoundryProviderSettings } from './azure-foundry-provider.js';

// -- Model settings ----------------------------------------------------------
// Pass these as the second argument to the provider call:
//   foundry('DeepSeek-R1', { temperature: 0.7, maxTokens: 1024 })
//
export type { AzureFoundryChatModelId, AzureFoundryChatSettings } from './azure-foundry-chat-options.js';

// -- Language model class ----------------------------------------------------
// Exposed for advanced use — e.g. constructing a model directly without the
// provider factory, or wrapping it in another abstraction.
//
export { AzureFoundryChatLanguageModel } from './azure-foundry-chat-language-model.js';

// -- Azure Identity credentials ----------------------------------------------
// Re-exported from @azure/identity so consumers don't need a direct dependency
// just to pass a custom credential:
//
//   import { createAzureFoundry, ManagedIdentityCredential } from '@nquandt/azure-ai-sdk';
//   const foundry = createAzureFoundry({
//     endpoint: '...',
//     credential: new ManagedIdentityCredential('<client-id>'),
//   });
//
export {
  DefaultAzureCredential,
  ManagedIdentityCredential,
  WorkloadIdentityCredential,
} from './azure-foundry-provider.js';

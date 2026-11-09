/**
 * Unit tests for createAzureFoundry — no real Azure dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAzureFoundry } from '../src/index.js';
import { fakeCredential, fakeFetch, chatResponse } from './helpers.js';

// Isolate all unit tests from .env values loaded by vitest config
beforeEach(() => {
  vi.stubEnv('AZURE_FOUNDRY_RESOURCE', '');
  vi.stubEnv('AZURE_FOUNDRY_PROJECT', '');
  vi.stubEnv('AZURE_AI_FOUNDRY_ENDPOINT', '');
  vi.stubEnv('AZURE_FOUNDRY_API_KEY', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('createAzureFoundry — provider construction', () => {
  it('throws when no endpoint is provided', () => {
    expect(() => createAzureFoundry()).toThrow(/endpoint is required/);
  });

  it('throws when endpoint is an empty string', () => {
    expect(() => createAzureFoundry({ endpoint: '' })).toThrow(/endpoint is required/);
  });

  it('returns a callable provider', () => {
    const foundry = createAzureFoundry({ endpoint: 'https://test.cognitiveservices.azure.com', credential: fakeCredential() });
    expect(typeof foundry).toBe('function');
  });

  it('provider.chat, chatModel, and provider.languageModel are equivalent aliases', () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({ endpoint: 'https://test.cognitiveservices.azure.com', credential: fakeCredential(), fetch });

    const a = foundry.chat('gpt-test');
    const b = foundry.languageModel('gpt-test');
    const c = foundry.chatModel!('gpt-test');
    expect(foundry.specificationVersion).toBe('v3');
    expect(a.modelId).toBe(b.modelId);
    expect(a.modelId).toBe(c.modelId);
    expect(requests).toHaveLength(0); // no call until doGenerate/doStream
  });

  it('embeddingModel throws NoSuchModelError', () => {
    const foundry = createAzureFoundry({ endpoint: 'https://test.cognitiveservices.azure.com', credential: fakeCredential() });
    expect(() => foundry.embeddingModel('ada')).toThrow();
  });

  it('calling provider as a function returns a model with the correct modelId', () => {
    const foundry = createAzureFoundry({ endpoint: 'https://test.cognitiveservices.azure.com', credential: fakeCredential() });
    const model = foundry('my-deployment');
    expect(model.modelId).toBe('my-deployment');
  });

  it('provider is the azure-foundry.chat provider', () => {
    const foundry = createAzureFoundry({ endpoint: 'https://test.cognitiveservices.azure.com', credential: fakeCredential() });
    expect(foundry('gpt-test').provider).toBe('azure-foundry.chat');
  });

  it('textEmbeddingModel throws NoSuchModelError', () => {
    const foundry = createAzureFoundry({ endpoint: 'https://test.cognitiveservices.azure.com', credential: fakeCredential() });
    expect(() => foundry.textEmbeddingModel('ada')).toThrow();
  });

  it('imageModel throws NoSuchModelError', () => {
    const foundry = createAzureFoundry({ endpoint: 'https://test.cognitiveservices.azure.com', credential: fakeCredential() });
    expect(() => foundry.imageModel!('dall-e')).toThrow();
  });

  it('strips trailing slash from endpoint', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://test.cognitiveservices.azure.com/',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(requests[0].url).not.toContain('//openai');
  });
});

describe('createAzureFoundry — URL routing', () => {
  it('cognitiveservices endpoint puts model in URL path', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('/openai/deployments/gpt-4o/chat/completions');
    expect(requests[0].body).not.toHaveProperty('model');
  });

  it('cognitiveservices endpoint appends api-version query param', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('api-version=');
  });

  it('cognitiveservices endpoint respects custom apiVersion', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      apiVersion: '2025-01-01',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('api-version=2025-01-01');
  });

  it('services.ai.azure.com endpoint puts model in request body', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-project.services.ai.azure.com/models',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('DeepSeek-R1').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('/chat/completions');
    expect(requests[0].url).not.toContain('/deployments/');
    expect(requests[0].body).toHaveProperty('model', 'DeepSeek-R1');
  });

  it('resourceName alone constructs services.ai.azure.com/models URL', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      resourceName: 'my-resource',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('DeepSeek-R1').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toBe('https://my-resource.services.ai.azure.com/models/chat/completions');
    expect(requests[0].body).toHaveProperty('model', 'DeepSeek-R1');
  });

  it('resourceName + projectId constructs /models URL (projectId is config-only, not a URL segment)', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      resourceName: 'my-resource',
      projectId: 'my-project',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-5-nano').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toBe('https://my-resource.services.ai.azure.com/models/chat/completions');
    expect(requests[0].body).toHaveProperty('model', 'gpt-5-nano');
  });

  it('services.ai.azure.com Claude calls /anthropic/v1/messages (not .../models/anthropic/...)', async () => {
    const anthropicWire = {
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 2 },
    };
    const { fetch, requests } = fakeFetch(anthropicWire);
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.services.ai.azure.com/models',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('claude-sonnet-4-6').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toBe('https://my-resource.services.ai.azure.com/anthropic/v1/messages');
    expect(requests[0].body).toHaveProperty('model', 'claude-sonnet-4-6');
  });

  it('resourceName takes precedence over endpoint', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      resourceName: 'my-resource',
      endpoint: 'https://should-be-ignored.cognitiveservices.azure.com',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-5-nano').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('my-resource.services.ai.azure.com');
  });

  it('encodes special characters in model/deployment name', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('my model/v2').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('my%20model%2Fv2');
  });
});

// ---------------------------------------------------------------------------
// Authentication scenarios
//
// Scenario 1: Foundry + Entra (az login / managed identity)
//   credential → DefaultAzureCredential, no apiKey, no subscriptionKey
//
// Scenario 2: Foundry + API key (direct key, replaces Entra entirely)
//   apiKey → used directly as Bearer token, Entra is skipped
//
// Scenario 3: APIM + Entra + subscription key
//   credential → Entra JWT, subscriptionKey → Ocp-Apim-Subscription-Key + api-key
// ---------------------------------------------------------------------------

describe('createAzureFoundry — authentication', () => {
  // Scenario 1: Foundry + Entra
  it('[Scenario 1] attaches Bearer token from credential', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      credential: fakeCredential('my-secret-token'),
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].headers['authorization']).toBe('Bearer my-secret-token');
    expect(requests[0].headers['ocp-apim-subscription-key']).toBeUndefined();
    expect(requests[0].headers['api-key']).toBeUndefined();
  });

  it('[Scenario 1] merges custom headers with auth header', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      credential: fakeCredential(),
      headers: { 'x-custom-header': 'custom-value' },
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].headers['authorization']).toMatch(/^Bearer /);
    expect(requests[0].headers['x-custom-header']).toBe('custom-value');
  });

  // Scenario 2: Foundry + API key (replaces Entra)
  it('[Scenario 2] apiKey is used directly as Bearer token — no Entra call', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.services.ai.azure.com/models',
      apiKey: 'my-api-key',
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].headers['authorization']).toBe('Bearer my-api-key');
    expect(requests[0].headers['ocp-apim-subscription-key']).toBeUndefined();
    expect(requests[0].headers['api-key']).toBeUndefined();
  });

  it('[Scenario 2] explicit headers are merged when using apiKey', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.services.ai.azure.com/models',
      apiKey: 'my-api-key',
      headers: { 'x-custom': 'val' },
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].headers['authorization']).toBe('Bearer my-api-key');
    expect(requests[0].headers['x-custom']).toBe('val');
  });

  // Scenario 3: APIM + Entra + subscription key
  it('[Scenario 3] subscriptionKey sends Ocp-Apim-Subscription-Key and api-key alongside Entra token', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-org.azure-api.net',
      endpointStyle: 'cognitive-services',
      credential: fakeCredential('entra-token'),
      subscriptionKey: 'my-apim-key',
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].headers['authorization']).toBe('Bearer entra-token');
    expect(requests[0].headers['ocp-apim-subscription-key']).toBe('my-apim-key');
    expect(requests[0].headers['api-key']).toBe('my-apim-key');
  });

  it('[Scenario 3] explicit headers take precedence over subscriptionKey', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-org.azure-api.net',
      endpointStyle: 'cognitive-services',
      credential: fakeCredential(),
      subscriptionKey: 'default-key',
      headers: { 'api-key': 'override-key' },
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].headers['api-key']).toBe('override-key');
  });

  it('no subscription headers are sent when neither apiKey nor subscriptionKey is set', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].headers['ocp-apim-subscription-key']).toBeUndefined();
    expect(requests[0].headers['api-key']).toBeUndefined();
  });
});

describe('createAzureFoundry — endpointStyle option', () => {
  it("endpointStyle 'cognitive-services' forces deployment-path URL for non-cognitiveservices hostname", async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-org.azure-api.net',
      endpointStyle: 'cognitive-services',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('/openai/deployments/gpt-4o/chat/completions');
    expect(requests[0].url).toContain('api-version=');
    expect(requests[0].body).not.toHaveProperty('model');
  });

  it("endpointStyle 'foundry' forces body-model URL for cognitiveservices hostname", async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      endpointStyle: 'foundry',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('DeepSeek-R1').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('/chat/completions');
    expect(requests[0].url).not.toContain('/deployments/');
    expect(requests[0].body).toHaveProperty('model', 'DeepSeek-R1');
  });

  it("endpointStyle 'auto' still infers cognitiveservices from hostname", async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com',
      endpointStyle: 'auto',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('/openai/deployments/gpt-4o/chat/completions');
  });

  it("endpointStyle 'auto' still infers foundry from non-cognitiveservices hostname", async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-project.services.ai.azure.com/models',
      endpointStyle: 'auto',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('DeepSeek-R1').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).not.toContain('/deployments/');
    expect(requests[0].body).toHaveProperty('model', 'DeepSeek-R1');
  });

  it("endpointStyle 'cognitive-services' respects custom apiVersion", async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-org.azure-api.net',
      endpointStyle: 'cognitive-services',
      apiVersion: '2025-03-01',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('api-version=2025-03-01');
  });

  it("endpointStyle 'cognitive-services' strips trailing /openai from endpoint", async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-org.azure-api.net/openai',
      endpointStyle: 'cognitive-services',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).not.toContain('/openai/openai/');
    expect(requests[0].url).toContain('/openai/deployments/gpt-4o/chat/completions');
  });

  it("endpointStyle 'cognitive-services' strips trailing /openai/ (with trailing slash) from endpoint", async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-org.azure-api.net/openai/',
      endpointStyle: 'cognitive-services',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).not.toContain('/openai/openai/');
    expect(requests[0].url).toContain('/openai/deployments/gpt-4o/chat/completions');
  });

  it("endpointStyle 'cognitive-services' strips trailing /openai from cognitiveservices endpoint", async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.cognitiveservices.azure.com/openai',
      endpointStyle: 'auto',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).not.toContain('/openai/openai/');
    expect(requests[0].url).toContain('/openai/deployments/gpt-4o/chat/completions');
  });
});

// ---------------------------------------------------------------------------
// Env-var fallbacks. Env values are set only via vi.stubEnv (the top-level
// beforeEach blanks them and afterEach restores them), so nothing leaks.
// ---------------------------------------------------------------------------

describe('createAzureFoundry — env fallbacks', () => {
  it('env AZURE_FOUNDRY_RESOURCE with no endpoint option builds the /models chat URL and sends model in body', async () => {
    vi.stubEnv('AZURE_FOUNDRY_RESOURCE', 'env-resource');
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({ credential: fakeCredential(), fetch });
    await foundry('DeepSeek-R1').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toBe('https://env-resource.services.ai.azure.com/models/chat/completions');
    expect(requests[0].body).toHaveProperty('model', 'DeepSeek-R1');
  });

  it('env explicit endpoint option beats AZURE_FOUNDRY_RESOURCE', async () => {
    vi.stubEnv('AZURE_FOUNDRY_RESOURCE', 'env-resource');
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://option.services.ai.azure.com/models',
      credential: fakeCredential(),
      fetch,
    });
    await foundry('DeepSeek-R1').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toBe('https://option.services.ai.azure.com/models/chat/completions');
  });

  it('env AZURE_AI_FOUNDRY_ENDPOINT is used when no other endpoint source is set', async () => {
    vi.stubEnv('AZURE_AI_FOUNDRY_ENDPOINT', 'https://env-endpoint.cognitiveservices.azure.com');
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({ credential: fakeCredential(), fetch });
    await foundry('gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].url).toContain('https://env-endpoint.cognitiveservices.azure.com/openai/deployments/gpt-4o/');
  });

  it('env AZURE_FOUNDRY_API_KEY is sent as Bearer when no credential is passed; explicit apiKey beats it', async () => {
    vi.stubEnv('AZURE_FOUNDRY_API_KEY', 'env-key-value');
    const envRun = fakeFetch(chatResponse('hi'));
    const fromEnv = createAzureFoundry({
      endpoint: 'https://my-resource.services.ai.azure.com/models',
      fetch: envRun.fetch,
    });
    await fromEnv('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(envRun.requests[0].headers['authorization']).toBe('Bearer env-key-value');

    const explicitRun = fakeFetch(chatResponse('hi'));
    const explicit = createAzureFoundry({
      endpoint: 'https://my-resource.services.ai.azure.com/models',
      apiKey: 'explicit-key-value',
      fetch: explicitRun.fetch,
    });
    await explicit('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(explicitRun.requests[0].headers['authorization']).toBe('Bearer explicit-key-value');
  });

  it('env AZURE_FOUNDRY_API_KEY is ignored when a credential is passed and appears in no header', async () => {
    vi.stubEnv('AZURE_FOUNDRY_API_KEY', 'env-key-secret');
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({
      endpoint: 'https://my-resource.services.ai.azure.com/models',
      credential: fakeCredential('entra-token'),
      fetch,
    });
    await foundry('gpt-test').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].headers['authorization']).toBe('Bearer entra-token');
    expect(Object.values(requests[0].headers)).not.toContain('Bearer env-key-secret');
    expect(Object.values(requests[0].headers).some((v) => v.includes('env-key-secret'))).toBe(false);
  });
});

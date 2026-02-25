/**
 * Unit tests for createAzureFoundry — no real Azure dependencies.
 */

import { describe, it, expect } from 'vitest';
import { createAzureFoundry } from '../src/index.js';
import { fakeCredential, fakeFetch, chatResponse } from './helpers.js';

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

  it('provider.chat and provider.languageModel are equivalent aliases', () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    const foundry = createAzureFoundry({ endpoint: 'https://test.cognitiveservices.azure.com', credential: fakeCredential(), fetch });

    const a = foundry.chat('gpt-test');
    const b = foundry.languageModel('gpt-test');
    expect(a.modelId).toBe(b.modelId);
    expect(requests).toHaveLength(0); // no call until doGenerate/doStream
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

describe('createAzureFoundry — authentication', () => {
  it('attaches Bearer token from credential', async () => {
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
  });

  it('merges custom headers with auth header', async () => {
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
});

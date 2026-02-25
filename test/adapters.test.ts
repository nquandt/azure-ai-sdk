/**
 * Unit tests for the adapter layer — resolveAdapter heuristics, explicit
 * override, and OpenAI-legacy wire-format differences.
 */

import { describe, it, expect } from 'vitest';
import { createAzureFoundry } from '../src/index.js';
import { resolveAdapter, OpenAIAdapter, OpenAILegacyAdapter } from '../src/adapters/index.js';
import { fakeCredential, fakeFetch, chatResponse } from './helpers.js';

const ENDPOINT = 'https://my-resource.cognitiveservices.azure.com';

function makeModel(
  fetch: typeof globalThis.fetch,
  modelId: string,
  settings: Parameters<ReturnType<typeof createAzureFoundry>>[1] = {},
) {
  return createAzureFoundry({ endpoint: ENDPOINT, credential: fakeCredential(), fetch })(modelId, settings);
}

// ---------------------------------------------------------------------------
// resolveAdapter — heuristic detection
// ---------------------------------------------------------------------------

describe('resolveAdapter — model ID heuristics', () => {
  it('o1 resolves to OpenAIAdapter', () => {
    expect(resolveAdapter('o1', undefined, () => 'id')).toBeInstanceOf(OpenAIAdapter);
  });

  it('o3-mini resolves to OpenAIAdapter', () => {
    expect(resolveAdapter('o3-mini', undefined, () => 'id')).toBeInstanceOf(OpenAIAdapter);
  });

  it('gpt-5-nano resolves to OpenAIAdapter', () => {
    expect(resolveAdapter('gpt-5-nano', undefined, () => 'id')).toBeInstanceOf(OpenAIAdapter);
  });

  it('gpt-4o resolves to OpenAILegacyAdapter', () => {
    expect(resolveAdapter('gpt-4o', undefined, () => 'id')).toBeInstanceOf(OpenAILegacyAdapter);
  });

  it('gpt-4o-mini resolves to OpenAILegacyAdapter', () => {
    expect(resolveAdapter('gpt-4o-mini', undefined, () => 'id')).toBeInstanceOf(OpenAILegacyAdapter);
  });

  it('gpt-4-turbo resolves to OpenAILegacyAdapter', () => {
    expect(resolveAdapter('gpt-4-turbo', undefined, () => 'id')).toBeInstanceOf(OpenAILegacyAdapter);
  });

  it('gpt-35-turbo (Azure deployment style) resolves to OpenAILegacyAdapter', () => {
    expect(resolveAdapter('gpt-35-turbo', undefined, () => 'id')).toBeInstanceOf(OpenAILegacyAdapter);
  });

  it('unknown model name defaults to OpenAIAdapter', () => {
    expect(resolveAdapter('some-custom-apim-deployment', undefined, () => 'id')).toBeInstanceOf(OpenAIAdapter);
  });
});

// ---------------------------------------------------------------------------
// resolveAdapter — explicit adapterType always wins
// ---------------------------------------------------------------------------

describe('resolveAdapter — explicit adapterType override', () => {
  it('forces openai-legacy on an o-series model ID', () => {
    // e.g. user behind APIM — deployment called "o1" but actually gpt-4o
    expect(resolveAdapter('o1', 'openai-legacy', () => 'id')).toBeInstanceOf(OpenAILegacyAdapter);
  });

  it('forces openai on a gpt-4o model ID', () => {
    expect(resolveAdapter('gpt-4o', 'openai', () => 'id')).toBeInstanceOf(OpenAIAdapter);
  });

  it('throws for anthropic (not yet implemented)', () => {
    expect(() => resolveAdapter('claude-3-5-sonnet', 'anthropic', () => 'id')).toThrow(/not yet implemented/);
  });
});

// ---------------------------------------------------------------------------
// OpenAI adapter wire format (max_completion_tokens)
// ---------------------------------------------------------------------------

describe('openai adapter — request shape', () => {
  it('sends max_completion_tokens', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch, 'gpt-5-nano').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 256,
    });
    expect(requests[0].body).toHaveProperty('max_completion_tokens', 256);
    expect(requests[0].body).not.toHaveProperty('max_tokens');
  });

  it('suppresses temperature=0', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch, 'gpt-5-nano').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0,
    });
    expect(requests[0].body).not.toHaveProperty('temperature');
  });
});

// ---------------------------------------------------------------------------
// OpenAI-legacy adapter wire format (max_tokens)
// ---------------------------------------------------------------------------

describe('openai-legacy adapter — request shape', () => {
  it('sends max_tokens instead of max_completion_tokens', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch, 'gpt-4o', { adapterType: 'openai-legacy' }).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 256,
    });
    expect(requests[0].body).toHaveProperty('max_tokens', 256);
    expect(requests[0].body).not.toHaveProperty('max_completion_tokens');
  });

  it('forwards temperature=0 explicitly', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch, 'gpt-4o', { adapterType: 'openai-legacy' }).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0,
    });
    expect(requests[0].body).toHaveProperty('temperature', 0);
  });

  it('auto-selects openai-legacy for gpt-4o without explicit adapterType', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch, 'gpt-4o').doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 128,
    });
    expect(requests[0].body).toHaveProperty('max_tokens', 128);
    expect(requests[0].body).not.toHaveProperty('max_completion_tokens');
  });
});

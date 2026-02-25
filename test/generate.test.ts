/**
 * Unit tests for AzureFoundryChatLanguageModel.doGenerate — no real Azure deps.
 */

import { describe, it, expect } from 'vitest';
import { createAzureFoundry } from '../src/index.js';
import {
  fakeCredential,
  fakeFetch,
  fakeErrorFetch,
  chatResponse,
} from './helpers.js';

const ENDPOINT = 'https://my-resource.cognitiveservices.azure.com';

function makeModel(fetch: typeof globalThis.fetch, modelId = 'gpt-test') {
  return createAzureFoundry({ endpoint: ENDPOINT, credential: fakeCredential(), fetch })(modelId);
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('doGenerate — request shape', () => {
  it('sends messages in the request body', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hello'));
    await makeModel(fetch).doGenerate({
      prompt: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    });

    expect(requests[0].body).toMatchObject({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    });
  });

  it('does not send temperature when it is 0 (SDK default)', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0,
    });

    expect(requests[0].body).not.toHaveProperty('temperature');
  });

  it('sends temperature when explicitly set to non-zero', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.7,
    });

    expect(requests[0].body).toHaveProperty('temperature', 0.7);
  });

  it('sends maxOutputTokens as max_tokens', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      maxOutputTokens: 512,
    });

    expect(requests[0].body).toHaveProperty('max_tokens', 512);
  });

  it('sends stop sequences', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stopSequences: ['STOP', 'END'],
    });

    expect(requests[0].body).toHaveProperty('stop', ['STOP', 'END']);
  });

  it('sends tools in regular mode', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch).doGenerate({
      tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
      toolChoice: { type: 'auto' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
    });

    expect(requests[0].body).toMatchObject({
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
      tool_choice: 'auto',
    });
  });

  it('sends tool_choice:none', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch).doGenerate({
      tools: [],
      toolChoice: { type: 'none' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].body).toHaveProperty('tool_choice', 'none');
  });

  it('sends specific tool_choice by name', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch).doGenerate({
      tools: [{
        type: 'function',
        name: 'my_tool',
        description: 'desc',
        inputSchema: {},
      }],
      toolChoice: { type: 'tool', toolName: 'my_tool' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(requests[0].body).toHaveProperty('tool_choice', {
      type: 'function',
      function: { name: 'my_tool' },
    });
  });

  it('injects JSON instruction message in object-json mode', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('{"foo":1}'));
    await makeModel(fetch).doGenerate({
      responseFormat: { type: 'json' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'give me json' }] }],
    });

    const messages = (requests[0].body as any).messages as any[];
    const lastMsg  = messages[messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content[0].text).toMatch(/JSON/i);
  });

  it('does not include undefined keys in the body', async () => {
    const { fetch, requests } = fakeFetch(chatResponse('hi'));
    await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    const body = requests[0].body as Record<string, unknown>;
    const undefinedKeys = Object.keys(body).filter(k => body[k] === undefined);
    expect(undefinedKeys).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe('doGenerate — response parsing', () => {
  it('returns the text content', async () => {
    const { fetch } = fakeFetch(chatResponse('Hello, world!'));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    const textPart = result.content.find(p => p.type === 'text');
    expect(textPart?.text).toBe('Hello, world!');
  });

  it('maps finish_reason stop → stop', async () => {
    const { fetch } = fakeFetch(chatResponse('hi', { finishReason: 'stop' }));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(result.finishReason).toBe('stop');
  });

  it('maps finish_reason length → length', async () => {
    const { fetch } = fakeFetch(chatResponse('hi', { finishReason: 'length' }));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(result.finishReason).toBe('length');
  });

  it('maps finish_reason content_filter → content-filter', async () => {
    const { fetch } = fakeFetch(chatResponse('', { finishReason: 'content_filter' }));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(result.finishReason).toBe('content-filter');
  });

  it('maps finish_reason tool_calls → tool-calls', async () => {
    const { fetch } = fakeFetch(chatResponse('', {
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'tc1', name: 'fn', arguments: '{}' }],
    }));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(result.finishReason).toBe('tool-calls');
  });

  it('returns usage token counts', async () => {
    const { fetch } = fakeFetch(chatResponse('hi', { promptTokens: 15, completionTokens: 25 }));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 25, totalTokens: 40 });
  });

  it('returns tool calls from the response', async () => {
    const { fetch } = fakeFetch(chatResponse('', {
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'tc1', name: 'get_weather', arguments: '{"city":"NYC"}' }],
    }));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'weather?' }] }],
    });

    const toolCalls = result.content.filter(p => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolCallId: 'tc1',
      toolName: 'get_weather',
      input: '{"city":"NYC"}',
    });
  });

  it('includes request body in result', async () => {
    const { fetch } = fakeFetch(chatResponse('hi'));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });

    expect(result.request?.body).toHaveProperty('messages');
  });
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe('doGenerate — unsupported setting warnings', () => {
  it('warns on topK', async () => {
    const { fetch } = fakeFetch(chatResponse('hi'));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      topK: 5,
    });

    expect(result.warnings).toContainEqual({ type: 'unsupported-setting', setting: 'topK' });
  });

  it('warns on presencePenalty', async () => {
    const { fetch } = fakeFetch(chatResponse('hi'));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      presencePenalty: 0.5,
    });

    expect(result.warnings).toContainEqual({ type: 'unsupported-setting', setting: 'presencePenalty' });
  });

  it('warns on frequencyPenalty', async () => {
    const { fetch } = fakeFetch(chatResponse('hi'));
    const result = await makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      frequencyPenalty: 0.5,
    });

    expect(result.warnings).toContainEqual({ type: 'unsupported-setting', setting: 'frequencyPenalty' });
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('doGenerate — error handling', () => {
  it('throws on 401 Unauthorized', async () => {
    const { fetch } = fakeErrorFetch({ error: { message: 'Unauthorized', code: '401' } }, 401);
    await expect(makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })).rejects.toThrow();
  });

  it('throws on 429 Too Many Requests', async () => {
    const { fetch } = fakeErrorFetch({ error: { message: 'Rate limit exceeded', code: '429' } }, 429);
    await expect(makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })).rejects.toThrow();
  });

  it('throws on 500 Internal Server Error', async () => {
    const { fetch } = fakeErrorFetch({ error: { message: 'Internal error', code: '500' } }, 500);
    await expect(makeModel(fetch).doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })).rejects.toThrow();
  });
});

/**
 * Unit tests for AzureFoundryChatLanguageModel.doStream — no real Azure deps.
 */

import { describe, it, expect } from 'vitest';
import { createAzureFoundry } from '../src/index.js';
import {
  fakeCredential,
  fakeStreamFetch,
  fakeErrorFetch,
  textDeltaChunk,
  finishChunk,
  toolCallDeltaChunk,
  toolCallArgsDeltaChunk,
} from './helpers.js';
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';

const ENDPOINT = 'https://my-resource.cognitiveservices.azure.com';

function makeModel(fetch: typeof globalThis.fetch, modelId = 'gpt-test') {
  return createAzureFoundry({ endpoint: ENDPOINT, credential: fakeCredential(), fetch })(modelId);
}

/** Drain a doStream result into an array of parts */
async function collectStream(model: ReturnType<typeof makeModel>, prompt = 'hi') {
  const { stream } = await model.doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  });

  const parts: LanguageModelV2StreamPart[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Basic streaming
// ---------------------------------------------------------------------------

describe('doStream — basic text streaming', () => {
  it('sends stream:true in the request body', async () => {
    const { fetch, requests } = fakeStreamFetch([
      textDeltaChunk('hi'),
      finishChunk(),
    ]);
    await collectStream(makeModel(fetch));
    expect(requests[0].body).toHaveProperty('stream', true);
  });

  it('emits text-delta parts for each content chunk', async () => {
    const { fetch } = fakeStreamFetch([
      textDeltaChunk('Hello'),
      textDeltaChunk(', '),
      textDeltaChunk('world'),
      finishChunk(),
    ]);
    const parts = await collectStream(makeModel(fetch));
    const deltas = parts.filter(p => p.type === 'text-delta').map(p => (p as any).delta);

    expect(deltas).toEqual(['Hello', ', ', 'world']);
  });

  it('emits a finish part with finishReason stop', async () => {
    const { fetch } = fakeStreamFetch([textDeltaChunk('hi'), finishChunk('stop')]);
    const parts = await collectStream(makeModel(fetch));
    const finish = parts.find(p => p.type === 'finish') as any;

    expect(finish).toBeDefined();
    expect(finish.finishReason).toBe('stop');
  });

  it('maps finish_reason length → length', async () => {
    const { fetch } = fakeStreamFetch([textDeltaChunk('hi'), finishChunk('length')]);
    const parts = await collectStream(makeModel(fetch));
    const finish = parts.find(p => p.type === 'finish') as any;

    expect(finish.finishReason).toBe('length');
  });

  it('maps finish_reason content_filter → content-filter', async () => {
    const { fetch } = fakeStreamFetch([finishChunk('content_filter')]);
    const parts = await collectStream(makeModel(fetch));
    const finish = parts.find(p => p.type === 'finish') as any;

    expect(finish.finishReason).toBe('content-filter');
  });

  it('emits usage in the finish part when provided in stream', async () => {
    const { fetch } = fakeStreamFetch([
      textDeltaChunk('hi'),
      finishChunk('stop', { prompt_tokens: 8, completion_tokens: 12 }),
    ]);
    const parts = await collectStream(makeModel(fetch));
    const finish = parts.find(p => p.type === 'finish') as any;

    expect(finish.usage).toEqual({ inputTokens: 8, outputTokens: 12, totalTokens: undefined });
  });

  it('finish usage defaults to undefined when not in stream', async () => {
    const { fetch } = fakeStreamFetch([textDeltaChunk('hi'), finishChunk('stop')]);
    const parts = await collectStream(makeModel(fetch));
    const finish = parts.find(p => p.type === 'finish') as any;

    expect(finish.usage).toEqual({ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
  });

  it('full text can be reconstructed from deltas', async () => {
    const { fetch } = fakeStreamFetch([
      textDeltaChunk('The '),
      textDeltaChunk('quick '),
      textDeltaChunk('brown fox'),
      finishChunk(),
    ]);
    const parts = await collectStream(makeModel(fetch));
    const text = parts
      .filter(p => p.type === 'text-delta')
      .map(p => (p as any).delta)
      .join('');

    expect(text).toBe('The quick brown fox');
  });

  it('emits stream-start as first part carrying warnings', async () => {
    const { fetch } = fakeStreamFetch([textDeltaChunk('hi'), finishChunk()]);
    const parts = await collectStream(makeModel(fetch));
    expect(parts[0].type).toBe('stream-start');
  });
});

// ---------------------------------------------------------------------------
// Streaming tool calls
// ---------------------------------------------------------------------------

describe('doStream — tool call streaming', () => {
  it('emits tool-input-start and tool-input-delta parts as arguments stream in', async () => {
    const { fetch } = fakeStreamFetch([
      toolCallDeltaChunk(0, 'tc-1', 'get_weather', '{"ci'),
      toolCallArgsDeltaChunk(0, 'ty":"NYC"}'),
      finishChunk('tool_calls'),
    ]);
    const parts = await collectStream(makeModel(fetch));
    const inputStart = parts.find(p => p.type === 'tool-input-start') as any;

    expect(inputStart).toBeDefined();
    expect(inputStart.toolName).toBe('get_weather');
    expect(inputStart.id).toBe('tc-1');
  });

  it('emits a completed tool-call part in flush', async () => {
    const { fetch } = fakeStreamFetch([
      toolCallDeltaChunk(0, 'tc-1', 'get_weather', '{"city":"NYC"}'),
      finishChunk('tool_calls'),
    ]);
    const parts = await collectStream(makeModel(fetch));
    const toolCall = parts.find(p => p.type === 'tool-call') as any;

    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe('get_weather');
    expect(toolCall.input).toContain('NYC');
  });

  it('accumulates split argument deltas into a single tool-call', async () => {
    const { fetch } = fakeStreamFetch([
      toolCallDeltaChunk(0, 'tc-1', 'search', '{"q":'),
      toolCallArgsDeltaChunk(0, '"hello world"}'),
      finishChunk('tool_calls'),
    ]);
    const parts = await collectStream(makeModel(fetch));
    const toolCall = parts.find(p => p.type === 'tool-call') as any;

    expect(toolCall.input).toBe('{"q":"hello world"}');
  });

  it('handles multiple concurrent tool calls', async () => {
    const { fetch } = fakeStreamFetch([
      toolCallDeltaChunk(0, 'tc-1', 'tool_a', '{"a":1}'),
      toolCallDeltaChunk(1, 'tc-2', 'tool_b', '{"b":2}'),
      finishChunk('tool_calls'),
    ]);
    const parts = await collectStream(makeModel(fetch));
    const toolCalls = parts.filter(p => p.type === 'tool-call') as any[];

    expect(toolCalls).toHaveLength(2);
    const names = toolCalls.map(tc => tc.toolName).sort();
    expect(names).toEqual(['tool_a', 'tool_b']);
  });

  it('finish reason is tool-calls when tools are called', async () => {
    const { fetch } = fakeStreamFetch([
      toolCallDeltaChunk(0, 'tc-1', 'fn', '{}'),
      finishChunk('tool_calls'),
    ]);
    const parts = await collectStream(makeModel(fetch));
    const finish = parts.find(p => p.type === 'finish') as any;

    expect(finish.finishReason).toBe('tool-calls');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('doStream — error handling', () => {
  it('throws on 401 Unauthorized', async () => {
    const { fetch } = fakeErrorFetch({ error: { message: 'Unauthorized', code: '401' } }, 401);
    await expect(collectStream(makeModel(fetch))).rejects.toThrow();
  });

  it('throws on 429 Too Many Requests', async () => {
    const { fetch } = fakeErrorFetch({ error: { message: 'Rate limit', code: '429' } }, 429);
    await expect(collectStream(makeModel(fetch))).rejects.toThrow();
  });
});

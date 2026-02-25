/**
 * Shared test helpers — no real Azure dependencies.
 */

import type { TokenCredential, AccessToken } from '@azure/identity';

// ---------------------------------------------------------------------------
// Fake credential
// ---------------------------------------------------------------------------

/**
 * A TokenCredential that returns a static dummy token immediately.
 * Satisfies the interface without touching Azure.
 */
export function fakeCredential(token = 'fake-token'): TokenCredential {
  return {
    getToken: async (): Promise<AccessToken> => ({
      token,
      expiresOnTimestamp: Date.now() + 3_600_000,
    }),
  };
}

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

export type CapturedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

/**
 * Creates a fake fetch function that returns a single JSON response and
 * captures the outbound request for assertions.
 */
export function fakeFetch(
  responseBody: unknown,
  status = 200,
): { fetch: typeof globalThis.fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url   = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body  = init?.body ? JSON.parse(init.body as string) : undefined;
    const hdrs: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => { hdrs[k] = v; });
    }
    requests.push({ url, method: init?.method ?? 'GET', headers: hdrs, body });

    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/**
 * Creates a fake fetch function that returns an SSE stream response and
 * captures the outbound request for assertions.
 */
export function fakeStreamFetch(
  chunks: unknown[],
): { fetch: typeof globalThis.fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url   = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body  = init?.body ? JSON.parse(init.body as string) : undefined;
    const hdrs: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => { hdrs[k] = v; });
    }
    requests.push({ url, method: init?.method ?? 'GET', headers: hdrs, body });

    const sseBody = [
      ...chunks.map(c => `data: ${JSON.stringify(c)}\n\n`),
      'data: [DONE]\n\n',
    ].join('');

    return new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };

  return { fetch: fetch as typeof globalThis.fetch, requests };
}

/**
 * Creates a fake fetch function that returns an error response.
 */
export function fakeErrorFetch(
  errorBody: unknown,
  status: number,
): { fetch: typeof globalThis.fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url   = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body  = init?.body ? JSON.parse(init.body as string) : undefined;
    const hdrs: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers as HeadersInit);
      h.forEach((v, k) => { hdrs[k] = v; });
    }
    requests.push({ url, method: init?.method ?? 'GET', headers: hdrs, body });

    return new Response(JSON.stringify(errorBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fetch: fetch as typeof globalThis.fetch, requests };
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

/** Minimal valid chat completions response */
export function chatResponse(text: string, options?: {
  model?: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}) {
  return {
    id: 'chatcmpl-test',
    model: options?.model ?? 'gpt-test',
    created: 1234567890,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: options?.toolCalls ? null : text,
        tool_calls: options?.toolCalls?.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      },
      finish_reason: options?.finishReason ?? 'stop',
    }],
    usage: {
      prompt_tokens: options?.promptTokens ?? 10,
      completion_tokens: options?.completionTokens ?? 20,
      total_tokens: (options?.promptTokens ?? 10) + (options?.completionTokens ?? 20),
    },
  };
}

/** A single SSE text delta chunk */
export function textDeltaChunk(content: string, index = 0) {
  return {
    id: 'chatcmpl-test',
    model: 'gpt-test',
    choices: [{
      index,
      delta: { role: 'assistant', content },
      finish_reason: null,
    }],
  };
}

/** A finish chunk (no content, has finish_reason and optional usage) */
export function finishChunk(finishReason = 'stop', usage?: { prompt_tokens: number; completion_tokens: number }) {
  return {
    id: 'chatcmpl-test',
    model: 'gpt-test',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: finishReason,
    }],
    ...(usage ? { usage } : {}),
  };
}

/** First delta of a tool call */
export function toolCallDeltaChunk(index: number, id: string, name: string, argsChunk: string) {
  return {
    id: 'chatcmpl-test',
    model: 'gpt-test',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          id,
          type: 'function',
          function: { name, arguments: argsChunk },
        }],
      },
      finish_reason: null,
    }],
  };
}

/** Subsequent argument delta for a streaming tool call */
export function toolCallArgsDeltaChunk(index: number, argsChunk: string) {
  return {
    id: 'chatcmpl-test',
    model: 'gpt-test',
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index,
          function: { name: null, arguments: argsChunk },
        }],
      },
      finish_reason: null,
    }],
  };
}

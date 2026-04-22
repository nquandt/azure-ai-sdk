/**
 * Integration tests for @nquandt/azure-ai-sdk
 *
 * Prerequisites:
 *   1. Copy .env.example to .env and fill in your values.
 *   2. az login  (DefaultAzureCredential picks up the session automatically)
 *
 * Run:
 *   npm test
 *
 * Any describe block whose required env vars are absent is skipped automatically.
 */

import { generateText, streamText } from 'ai';
import { describe, it, expect, beforeEach } from 'vitest';
import { createAzureFoundry } from '../src/index.js';

// ---------------------------------------------------------------------------
// Env — all config comes from environment variables, never hardcoded
// ---------------------------------------------------------------------------

// The full endpoint URL — reads AZURE_FOUNDRY_ENDPOINT for backwards compat,
// then falls back to AZURE_AI_FOUNDRY_ENDPOINT (the provider's own env var).
const FOUNDRY_ENDPOINT = process.env.AZURE_FOUNDRY_ENDPOINT || process.env.AZURE_AI_FOUNDRY_ENDPOINT;
const FOUNDRY_RESOURCE = process.env.AZURE_FOUNDRY_RESOURCE;
const FOUNDRY_PROJECT  = process.env.AZURE_FOUNDRY_PROJECT;
const FOUNDRY_MODEL    = process.env.AZURE_FOUNDRY_MODEL;
const FOUNDRY_API_KEY  = process.env.AZURE_FOUNDRY_API_KEY;

// Per-model endpoint overrides for multi-model testing
const KIMI_ENDPOINT    = process.env.AZURE_FOUNDRY_KIMI_ENDPOINT;
const KIMI_MODEL       = process.env.AZURE_FOUNDRY_KIMI_MODEL;
const KIMI_API_KEY     = process.env.AZURE_FOUNDRY_KIMI_API_KEY;

const CLAUDE_ENDPOINT  = process.env.AZURE_FOUNDRY_CLAUDE_ENDPOINT;
const CLAUDE_MODEL     = process.env.AZURE_FOUNDRY_CLAUDE_MODEL;
const CLAUDE_API_KEY   = process.env.AZURE_FOUNDRY_CLAUDE_API_KEY;

const APIM_ENDPOINT    = process.env.AZURE_APIM_ENDPOINT;
const APIM_MODEL       = process.env.AZURE_APIM_MODEL;
const APIM_SCOPE       = process.env.AZURE_APIM_SCOPE;

// Helper to build a consistent test suite for any endpoint + model combination
function createModelTests(
  label: string,
  makeModel: () => ReturnType<ReturnType<typeof createAzureFoundry>>,
) {
  let model: ReturnType<ReturnType<typeof createAzureFoundry>>;

  beforeEach(() => {
    model = makeModel();
  });

  it(`[${label}] generateText returns a non-empty response`, async () => {
    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user',   content: 'In one sentence, what is Azure OpenAI Service?' },
      ],
    });

    expect(result.text).toBeTruthy();
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it(`[${label}] streamText streams chunks and completes`, async () => {
    const result = streamText({
      model,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user',   content: 'Count from 1 to 3, one number per line.' },
      ],
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      expect(typeof chunk).toBe('string');
      fullText += chunk;
    }

    expect(fullText).toBeTruthy();
    expect(fullText).toMatch(/1/);
    expect(fullText).toMatch(/2/);
    expect(fullText).toMatch(/3/);
  });
}

// ---------------------------------------------------------------------------
// GPT-5.4-nano (openai adapter, auto-detected)
// ---------------------------------------------------------------------------

const foundryReady = Boolean((FOUNDRY_ENDPOINT || FOUNDRY_RESOURCE) && FOUNDRY_MODEL);

describe.skipIf(!foundryReady)('Azure AI Foundry — GPT-5.4-nano', () => {
  createModelTests('gpt-5.4-nano', () => {
    const foundry = createAzureFoundry({
      ...(FOUNDRY_RESOURCE
        ? { resourceName: FOUNDRY_RESOURCE, projectId: FOUNDRY_PROJECT }
        : { endpoint: FOUNDRY_ENDPOINT! }),
      ...(FOUNDRY_API_KEY ? { apiKey: FOUNDRY_API_KEY } : {}),
    });
    return foundry(FOUNDRY_MODEL!);
  });
});

// ---------------------------------------------------------------------------
// Kimi-K2.5 (openai-legacy adapter, auto-detected)
// ---------------------------------------------------------------------------

const kimiReady = Boolean(KIMI_ENDPOINT && KIMI_MODEL);

describe.skipIf(!kimiReady)('Azure AI Foundry — Kimi-K2.5', () => {
  createModelTests('Kimi-K2.5', () => {
    const foundry = createAzureFoundry({
      endpoint: KIMI_ENDPOINT!,
      ...(KIMI_API_KEY ? { apiKey: KIMI_API_KEY } : {}),
    });
    return foundry(KIMI_MODEL!);
  });
});

// ---------------------------------------------------------------------------
// Claude Sonnet 4.6 (anthropic adapter, auto-detected)
// URL: /anthropic/v1/messages (set by AnthropicAdapter)
// ---------------------------------------------------------------------------

const claudeReady = Boolean(CLAUDE_ENDPOINT && CLAUDE_MODEL);

describe.skipIf(!claudeReady)('Azure AI Foundry — Claude Sonnet 4.6', () => {
  createModelTests('claude-sonnet-4-6', () => {
    const foundry = createAzureFoundry({
      endpoint: CLAUDE_ENDPOINT!,
      ...(CLAUDE_API_KEY ? { apiKey: CLAUDE_API_KEY } : {}),
    });
    return foundry(CLAUDE_MODEL!);
  });
});

// ---------------------------------------------------------------------------
// Tests — APIM gateway
//
// BLOCKED: The APIM validate-jwt policy currently only accepts tokens for the
// custom app registration audience. DefaultAzureCredential produces tokens for
// https://cognitiveservices.azure.com or https://ai.azure.com, both of which
// are rejected by the current policy.
//
// Set AZURE_APIM_SCOPE to the app registration workaround scope until fixed.
// Set all three AZURE_APIM_* vars to enable these tests.
// See docs/apim-integration.md for the required policy change and workaround.
// ---------------------------------------------------------------------------

// All three vars must be set AND the APIM policy must have been updated to accept
// https://cognitiveservices.azure.com / https://ai.azure.com audiences.
// See docs/apim-integration.md.
const apimReady = false; // flip to: Boolean(APIM_ENDPOINT && APIM_MODEL && APIM_SCOPE)

describe.skipIf(!apimReady)('Azure AI Foundry — APIM gateway', () => {
  let model: ReturnType<ReturnType<typeof createAzureFoundry>>;

  beforeEach(() => {
    const foundry = createAzureFoundry({
      endpoint: APIM_ENDPOINT!,
      scope: APIM_SCOPE!,
    });
    model = foundry(APIM_MODEL!);
  });

  it('generateText returns a non-empty response via APIM', async () => {
    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user',   content: 'In one sentence, what is Azure OpenAI Service?' },
      ],
    });

    expect(result.text).toBeTruthy();
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('streamText streams chunks and completes via APIM', async () => {
    const result = streamText({
      model,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user',   content: 'Count from 1 to 3, one number per line.' },
      ],
    });

    let fullText = '';
    for await (const chunk of result.textStream) {
      expect(typeof chunk).toBe('string');
      fullText += chunk;
    }

    expect(fullText).toBeTruthy();
    expect(fullText).toMatch(/1/);
    expect(fullText).toMatch(/2/);
    expect(fullText).toMatch(/3/);
  });
});

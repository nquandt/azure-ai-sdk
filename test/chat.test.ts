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

const FOUNDRY_ENDPOINT = process.env.AZURE_FOUNDRY_ENDPOINT;
const FOUNDRY_MODEL    = process.env.AZURE_FOUNDRY_MODEL;

const APIM_ENDPOINT    = process.env.AZURE_APIM_ENDPOINT;
const APIM_MODEL       = process.env.AZURE_APIM_MODEL;
const APIM_SCOPE       = process.env.AZURE_APIM_SCOPE;

// ---------------------------------------------------------------------------
// Tests — direct Azure AI Foundry
// ---------------------------------------------------------------------------

const foundryReady = Boolean(FOUNDRY_ENDPOINT && FOUNDRY_MODEL);

describe.skipIf(!foundryReady)('Azure AI Foundry — direct', () => {
  let model: ReturnType<ReturnType<typeof createAzureFoundry>>;

  beforeEach(() => {
    const foundry = createAzureFoundry({ endpoint: FOUNDRY_ENDPOINT! });
    model = foundry(FOUNDRY_MODEL!);
  });

  it('generateText returns a non-empty response', async () => {
    const result = await generateText({
      model,
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user',   content: 'In one sentence, what is Azure OpenAI Service?' },
      ],
    });

    expect(result.text).toBeTruthy();
    expect(result.finishReason).toBe('stop');
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });

  it('streamText streams chunks and completes', async () => {
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
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
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

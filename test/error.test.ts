/**
 * Unit tests for azureFoundryFailedResponseHandler — the retry rule and the
 * error body parse. No real Azure deps.
 */

import { describe, it, expect } from 'vitest';
import { APICallError } from '@ai-sdk/provider';
import { azureFoundryFailedResponseHandler } from '../src/azure-foundry-error.js';
import { fakeErrorFetch } from './helpers.js';

const URL_UNDER_TEST = 'https://my-resource.cognitiveservices.azure.com/openai/deployments/gpt-test/chat/completions';

/** Runs the handler on a JSON error response produced by the shared fakeErrorFetch. */
async function handleJson(errorBody: unknown, status: number): Promise<APICallError> {
  const { fetch } = fakeErrorFetch(errorBody, status);
  const response = await fetch(URL_UNDER_TEST, { method: 'POST' });
  const { value } = await azureFoundryFailedResponseHandler({
    response,
    url: URL_UNDER_TEST,
    requestBodyValues: {},
  });
  expect(APICallError.isInstance(value)).toBe(true);
  return value as APICallError;
}

/** Runs the handler on a raw (non-JSON or empty) body with an explicit status text. */
async function handleRaw(rawBody: string, status: number, statusText: string): Promise<APICallError> {
  const response = new Response(rawBody, { status, statusText });
  const { value } = await azureFoundryFailedResponseHandler({
    response,
    url: URL_UNDER_TEST,
    requestBodyValues: {},
  });
  expect(APICallError.isInstance(value)).toBe(true);
  return value as APICallError;
}

// ---------------------------------------------------------------------------
// Retry rule
// ---------------------------------------------------------------------------

describe('azureFoundryFailedResponseHandler — retry rule', () => {
  it('marks 429 Too Many Requests as retryable', async () => {
    const err = await handleJson({ error: { message: 'Rate limit exceeded', code: '429' } }, 429);
    expect(err.statusCode).toBe(429);
    expect(err.isRetryable).toBe(true);
  });

  it.each([500, 502, 503, 504, 599])('marks %i as retryable', async (status) => {
    const err = await handleJson({ error: { message: `status ${status}`, code: String(status) } }, status);
    expect(err.statusCode).toBe(status);
    expect(err.isRetryable).toBe(true);
  });

  it.each([400, 401, 403, 404, 499])('marks %i as not retryable', async (status) => {
    const err = await handleJson({ error: { message: `status ${status}`, code: String(status) } }, status);
    expect(err.statusCode).toBe(status);
    expect(err.isRetryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error body parse
// ---------------------------------------------------------------------------

describe('azureFoundryFailedResponseHandler — error body parse', () => {
  it('uses the message from an Azure error body', async () => {
    const err = await handleJson(
      { error: { code: 'DeploymentNotFound', message: 'The API deployment does not exist', status: 404 } },
      404,
    );
    expect(err.message).toBe('The API deployment does not exist');
    expect(err.statusCode).toBe(404);
    expect(err.data).toMatchObject({ error: { code: 'DeploymentNotFound' } });
  });

  it('accepts an error body without optional code or status', async () => {
    const err = await handleJson({ error: { message: 'Bad things' } }, 400);
    expect(err.message).toBe('Bad things');
    expect(err.isRetryable).toBe(false);
  });

  it('still returns an APICallError when the JSON body does not match the schema', async () => {
    const err = await handleRaw(JSON.stringify({ detail: 'something else entirely' }), 500, 'Internal Server Error');
    expect(err.statusCode).toBe(500);
    expect(err.isRetryable).toBe(true);
    // Schema did not match, so the message falls back to the HTTP status text.
    expect(err.message).toBe('Internal Server Error');
    expect(err.data).toBeUndefined();
  });

  it('still returns an APICallError when the body is not JSON', async () => {
    const err = await handleRaw('<html>Service Unavailable</html>', 503, 'Service Unavailable');
    expect(err.statusCode).toBe(503);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toBe('Service Unavailable');
  });

  it('still returns an APICallError when the body is empty', async () => {
    const err = await handleRaw('', 429, 'Too Many Requests');
    expect(err.statusCode).toBe(429);
    expect(err.isRetryable).toBe(true);
    expect(err.message).toBe('Too Many Requests');
  });

  it('keeps 4xx non-retryable even when the body does not match the schema', async () => {
    const err = await handleRaw(JSON.stringify({ nope: true }), 401, 'Unauthorized');
    expect(err.statusCode).toBe(401);
    expect(err.isRetryable).toBe(false);
  });
});

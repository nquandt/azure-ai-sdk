# AGENTS.md

Guidelines for AI agents (Copilot, Claude, Cursor, etc.) working in this repository.

---

## Repository overview

`@nquandt/azure-ai-sdk` is a [Vercel AI SDK](https://sdk.vercel.ai) custom provider for Azure AI Foundry.
It authenticates via Azure Entra identity (`@azure/identity`) — there are no API keys anywhere in the codebase.

```
src/
  index.ts                              Public API surface — re-exports everything
  azure-foundry-provider.ts             Factory: createAzureFoundry()
  azure-foundry-chat-language-model.ts  Core LanguageModelV1 implementation
  azure-foundry-chat-options.ts         Types: AzureFoundryChatSettings
  azure-foundry-error.ts                Error handler (Zod schema + retryable status codes)
  version.ts                            VERSION constant

test/
  helpers.ts                            Shared mock utilities (fakeCredential, fakeFetch, etc.)
  provider.test.ts                      Unit tests — provider construction, URL routing, auth headers
  generate.test.ts                      Unit tests — doGenerate request/response/errors
  stream.test.ts                        Unit tests — doStream SSE parsing/errors
  chat.test.ts                          Integration tests — skipped unless env vars are set

scripts/
  set-version.mjs                       Stamps a version into package.json and jsr.json from a git tag

.github/workflows/publish.yml           CI: build+test on every push; publish to npm+JSR on v* tags
docs/
  apim-integration.md                   Notes on using the SDK with an APIM gateway
  custom-provider.md                    Reference doc for the AI SDK custom provider interface
```

---

## Build and test

```bash
npm install          # install dependencies
npm run typecheck    # tsc --noEmit (no emit, just type checking)
npm run build        # tsc -p tsconfig.build.json → dist/
npm test             # vitest run (unit tests only unless env vars are set)
npm run test:watch   # vitest in watch mode
```

**Always run `npm run typecheck && npm test` before committing.**

---

## Testing approach

### Unit tests (no Azure required)

The test suite uses an in-memory mock layer in `test/helpers.ts`. Every unit test injects fakes directly
into `createAzureFoundry`:

```ts
createAzureFoundry({
  endpoint: 'https://test.cognitiveservices.azure.com',
  credential: fakeCredential(),   // returns a static dummy token, no network call
  fetch: fakeFetch(chatResponse('Hello')),  // returns a canned JSON response
});
```

- `fakeCredential(token?)` — satisfies `TokenCredential` without any Azure calls
- `fakeFetch(body, status?)` — captures outbound requests for assertion, returns a single JSON response
- `fakeStreamFetch(chunks[])` — returns a `text/event-stream` response with serialised SSE chunks
- `fakeErrorFetch(body, status)` — returns a non-2xx response for error-path testing
- `chatResponse(text, options?)` — builds a valid OpenAI chat completions JSON object
- `textDeltaChunk`, `finishChunk`, `toolCallDeltaChunk`, `toolCallArgsDeltaChunk` — SSE chunk builders

Do not use `vi.mock`, `msw`, or `nock`. Keep the in-memory injection pattern.

### Integration tests (`test/chat.test.ts`)

Skipped automatically when the required env vars are absent. To run them locally:

```bash
cp .env.example .env
# fill in AZURE_FOUNDRY_ENDPOINT and AZURE_FOUNDRY_MODEL
az login
npm test
```

Do not add `createAzureFoundry(...)` calls at the top level of `describe` blocks — construction must happen
inside `beforeEach` so `describe.skipIf` can suppress execution before the call is reached.

### CI

The GitHub Actions workflow (`publish.yml`) runs with no Azure secrets, so integration tests are always skipped
in CI. Only the unit tests must pass for the pipeline to succeed.

---

## Code conventions

- **TypeScript strict mode** — `tsconfig.json` has `strict: true`. No `any` without a comment explaining why.
- **No API keys** — all authentication goes through `TokenCredential` / `getBearerTokenProvider`.
- **No default exports** — named exports only.
- **ESM only** — `"type": "module"` in `package.json`. Use `.js` extensions in imports even for `.ts` source files.
- **Zod for response validation** — parse API responses with Zod schemas; do not cast with `as`.
- **Error handling** — use `createJsonErrorResponseHandler` from `@ai-sdk/provider-utils`. Mark 429 and ≥500 as retryable in `azure-foundry-error.ts`.

---

## URL routing

The provider detects the endpoint type at construction time:

| Endpoint contains | URL pattern | Model sent in |
|---|---|---|
| `cognitiveservices.azure.com` | `{endpoint}/openai/deployments/{encodeURIComponent(modelId)}/chat/completions?api-version={apiVersion}` | URL path |
| anything else | `{endpoint}/chat/completions` | Request body as `model` |

Default `apiVersion` is `'2024-10-21'`. The model name is always `encodeURIComponent`-encoded in the URL path.

---

## Authentication flow

```
createAzureFoundry({ endpoint, credential?, scope? })
  credential = options.credential ?? new DefaultAzureCredential()
  scope      = options.scope ?? 'https://cognitiveservices.azure.com/.default'
  getToken   = getBearerTokenProvider(credential, scope)   ← cached + auto-refreshed

  before each request:
    getHeaders() → { Authorization: 'Bearer <token>', ...customHeaders }
```

`DefaultAzureCredential` resolution order: env vars → workload identity → managed identity → Azure CLI → PowerShell → VS Code.

---

## Adding a new feature

1. Implement in `src/azure-foundry-chat-language-model.ts` or `src/azure-foundry-provider.ts`.
2. Export from `src/index.ts` if it is part of the public API.
3. Add unit tests using the helpers in `test/helpers.ts`. No real Azure calls in unit tests.
4. Run `npm run typecheck && npm test` and ensure all tests pass.
5. Update `README.md` if the public API or configuration options change.

---

## Releasing

Releases are fully automated via GitHub Actions on version tag push. `scripts/set-version.mjs` stamps the
version from the git tag into `package.json` and `jsr.json` at publish time.

`package.json` and `jsr.json` are committed with the stub version `0.0.0-dev`. The git tag is the source of
truth for the published version — do not manually update the version fields in those files.

1. Commit any outstanding changes to master and push:
   ```bash
   git push origin master
   ```
2. Tag and push — use the `v` prefix:
   ```bash
   git tag -a v0.1.2 -m "v0.1.2"
   git push origin v0.1.2
   ```
3. The `publish.yml` workflow publishes to npm and JSR automatically.

Required repository secrets: `NPM_TOKEN`. JSR uses OIDC and requires no secret.

---

## What this SDK does not support

- Embeddings (`textEmbeddingModel` throws `NoSuchModelError`)
- Image generation (`imageModel` throws `NoSuchModelError`)
- The settings `topK`, `presencePenalty`, and `frequencyPenalty` — these emit `unsupported-setting` warnings and are ignored

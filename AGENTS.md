# AGENTS.md

Guidelines for AI agents (Copilot, Claude, Cursor, etc.) working in this repository.

---

## Repository overview

`@nquandt/azure-ai-sdk` is a [Vercel AI SDK](https://sdk.vercel.ai) custom provider for Azure AI Foundry.
It implements `LanguageModelV3` (`@ai-sdk/provider` 3) and targets `ai` 6 (peer dependency).
By default it authenticates via Azure Entra identity (`@azure/identity`). An `apiKey` option (or `AZURE_FOUNDRY_API_KEY`)
bypasses Entra for local testing only; `subscriptionKey` adds APIM headers alongside the Entra token.

```
src/
  index.ts                              Public API surface — createAzureFoundry, settings types, model class
  azure-foundry-provider.ts             Factory: createAzureFoundry()
  azure-foundry-chat-language-model.ts  Core LanguageModelV3 implementation (doGenerate, doStream)
  azure-foundry-chat-options.ts         Types: AzureFoundryChatModelId, AzureFoundryChatSettings
  azure-foundry-error.ts                Error handler (Zod schema + retryable status codes)
  version.ts                            VERSION constant
  adapters/
    index.ts                            resolveAdapter() — picks the adapter for a model
    types.ts                            ChatAdapter interface, AdapterType
    openai-adapter.ts                   OpenAIAdapter — max_completion_tokens (o-series, gpt-5+)
    openai-legacy-adapter.ts            OpenAILegacyAdapter — max_tokens (gpt-4*, gpt-35, kimi)
    anthropic-adapter.ts                AnthropicAdapter — Messages API (claude*)

test/
  helpers.ts                            Shared mock utilities (fakeCredential, fakeFetch, etc.)
  provider.test.ts                      Unit tests — provider construction, URL routing, auth headers, endpointStyle
  generate.test.ts                      Unit tests — doGenerate request/response/errors
  stream.test.ts                        Unit tests — doStream SSE parsing/errors
  adapters.test.ts                      Unit tests — resolveAdapter heuristics, explicit adapterType, adapter request shapes
  chat.test.ts                          Integration tests — skipped unless env vars are set

scripts/
  set-version.mjs                       Stamps a version into package.json and jsr.json from a git tag

.github/workflows/publish.yml           CI: typecheck, test, build on push/PR to master; publish to npm+JSR on v* tags
docs/
  apim-integration.md                   Notes on using the SDK with an APIM gateway
  custom-provider.md                    Azure provider setup, usage and models tested with the AI SDK
  opencode.md                           Using the SDK as a custom provider in OpenCode

Root config: package.json and jsr.json (version stub 0.0.0-dev), tsconfig.json, tsconfig.build.json,
vitest.config.ts, .env.example
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
const { fetch, requests } = fakeFetch(chatResponse('Hello'));
const foundry = createAzureFoundry({
  endpoint: 'https://test.cognitiveservices.azure.com',
  credential: fakeCredential(),   // returns a static dummy token, no network call
  fetch,                          // returns a canned JSON response; `requests` captures outbound calls
});
```

- `fakeCredential(token?)` — satisfies `TokenCredential` without any Azure calls
- `fakeFetch(body, status?)` — returns `{ fetch, requests }`; captures outbound requests for assertion, returns a single JSON response
- `fakeStreamFetch(chunks[])` — returns `{ fetch, requests }`; a `text/event-stream` response with serialised SSE chunks
- `fakeErrorFetch(body, status)` — returns `{ fetch, requests }`; a non-2xx response for error-path testing
- `chatResponse(text, options?)` — builds a valid OpenAI chat completions JSON object
- `textDeltaChunk`, `finishChunk`, `toolCallDeltaChunk`, `toolCallArgsDeltaChunk` — SSE chunk builders

Do not use `vi.mock`, `msw`, or `nock`. Keep the in-memory injection pattern.

### Integration tests (`test/chat.test.ts`)

Skipped automatically when the required env vars are absent. To run them locally:

```bash
cp .env.example .env
# fill in AZURE_FOUNDRY_ENDPOINT (or AZURE_FOUNDRY_RESOURCE) and AZURE_FOUNDRY_MODEL
az login
npm test
```

The suites cover the resource endpoint (GPT-5.4-nano), Kimi-K2.5 (`AZURE_FOUNDRY_KIMI_ENDPOINT` / `_MODEL`),
and Claude Sonnet 4.6 (`AZURE_FOUNDRY_CLAUDE_ENDPOINT` / `_MODEL`). The APIM suite is disabled
(`apimReady = false` in the file) until the APIM policy accepts the Entra audiences.

Do not add `createAzureFoundry(...)` calls at the top level of `describe` blocks — construction must happen
inside `beforeEach` so `describe.skipIf` can suppress execution before the call is reached.

**Before shipping any change that touches URL construction or `api-version` defaults, run the integration
tests locally against a real endpoint.** Unit tests only assert that URLs are constructed the way the test
was written — they cannot catch a mismatch between what the code generates and what the Azure service
actually accepts. Run the suites above against real endpoints (resource, Kimi, Claude) before considering a
URL-routing change validated.

### CI

The GitHub Actions workflow (`publish.yml`) runs with no Azure secrets, so integration tests are always skipped
in CI. Only the unit tests must pass for the pipeline to succeed.

---

## Code conventions

- **TypeScript strict mode** — `tsconfig.json` has `strict: true`. No `any` without a comment explaining why.
- **Entra by default** — auth goes through `TokenCredential` / `getBearerTokenProvider`. The `apiKey` option
  bypasses Entra and is documented for local testing.
- **No default exports** — named exports only.
- **ESM only** — `"type": "module"` in `package.json`. Use `.js` extensions in imports even for `.ts` source files.
- **Zod for response validation** — parse API responses with Zod schemas; do not cast with `as`.
- **Error handling** — use `createJsonErrorResponseHandler` from `@ai-sdk/provider-utils`. Mark 429 and ≥500 as retryable in `azure-foundry-error.ts`.

---

## URL routing

Endpoint resolution, first match wins: `resourceName` → `endpoint` option → `AZURE_FOUNDRY_RESOURCE` →
`AZURE_AI_FOUNDRY_ENDPOINT`. A `resourceName` becomes `https://{resourceName}.services.ai.azure.com/models`.
`projectId` is configuration only and does not change the URL.

The provider picks an endpoint style at construction time. `endpointStyle` (`'auto'` by default) can force it,
e.g. for an APIM gateway. `'auto'` uses `cognitive-services` when the endpoint contains `cognitiveservices.azure.com`,
otherwise `foundry`.

| Endpoint style | URL pattern | Model sent in |
|---|---|---|
| `cognitive-services` | `{endpoint}/openai/deployments/{encodeURIComponent(modelId)}/chat/completions?api-version={apiVersion}` | URL path |
| `foundry` | `{endpoint}/chat/completions` | Request body as `model` |

Default `apiVersion` is `'2024-10-21'` and applies to the `cognitive-services` style only. A trailing `/openai` on the
endpoint is stripped. Adapters can override the path: Anthropic uses `/anthropic/v1/messages`. For the `foundry` style,
a trailing `/models` is stripped first, so `.../models` becomes `.../anthropic/v1/messages`.

---

## Authentication flow

```
createAzureFoundry({ endpoint, credential?, scope?, apiKey?, subscriptionKey?, headers? })
  apiKey set (option, or AZURE_FOUNDRY_API_KEY when no credential is passed)
    → Authorization: Bearer <apiKey>; Entra is skipped
  otherwise
    credential = options.credential ?? new DefaultAzureCredential()   (@azure/identity imported lazily)
    scope      = options.scope ?? (*.services.ai.azure.com ? 'https://ai.azure.com/.default'
                                                          : 'https://cognitiveservices.azure.com/.default')
    getToken   = getBearerTokenProvider(credential, scope)   ← cached + auto-refreshed

  before each request (Entra path):
    Authorization: Bearer <token>
    + Ocp-Apim-Subscription-Key and api-key, if subscriptionKey is set
    + options.headers (these win over anything above)
  (apiKey path: Authorization + options.headers only; subscriptionKey is not sent)
```

`DefaultAzureCredential` order (per `@azure/identity` 4.13): env vars → workload identity → managed identity →
VS Code → Azure CLI → Azure PowerShell → Azure Developer CLI → broker (if installed).

---

## Adapters

The wire format lives in `src/adapters/`, not in the language model. `resolveAdapter()` picks the adapter in this order:

1. Explicit `adapterType` setting (`'openai' | 'openai-legacy' | 'anthropic'`) — always wins.
2. Model ID heuristic: `claude*` → `anthropic`; `gpt-4*`, `gpt-35*`, `gpt-3.5*`, `kimi*` → `openai-legacy`;
   `o<digit>*`, `gpt-5*` → `openai`.
3. Anything else → `openai`.

---

## Adding a new feature

1. Implement in `src/azure-foundry-chat-language-model.ts` or `src/azure-foundry-provider.ts`. A new model family
   with its own wire format goes in `src/adapters/`: implement `ChatAdapter` and register it in `resolveAdapter()`.
2. Export from `src/index.ts` if it is part of the public API.
3. Add unit tests using the helpers in `test/helpers.ts` (adapter behaviour goes in `test/adapters.test.ts`). No real Azure calls in unit tests.
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

- Embeddings (`embeddingModel` and `textEmbeddingModel` throw `NoSuchModelError`)
- Image generation (`imageModel` throws `NoSuchModelError`)
- The settings `topK`, `presencePenalty`, and `frequencyPenalty` — these emit an `unsupported` warning (`{ type: 'unsupported', feature }`) and are ignored

# @nquandt/azure-ai-sdk

A [Vercel AI SDK](https://sdk.vercel.ai) custom provider for [Azure AI Foundry](https://ai.azure.com) that authenticates using **Azure Entra identity** — no API keys required.

Works with any Azure-hosted chat model: GPT-4o, DeepSeek-R1, Llama, Cohere, Phi, and others.

[![npm](https://img.shields.io/npm/v/@nquandt/azure-ai-sdk)](https://www.npmjs.com/package/@nquandt/azure-ai-sdk)
[![JSR](https://jsr.io/badges/@nquandt/azure-ai-sdk)](https://jsr.io/@nquandt/azure-ai-sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Installation

```bash
npm install @nquandt/azure-ai-sdk
```

Or from JSR:

```bash
npx jsr add @nquandt/azure-ai-sdk
```

---

## Prerequisites

- An [Azure AI Foundry](https://ai.azure.com) resource or Azure OpenAI resource
- A deployed model (e.g. `gpt-4o`, `DeepSeek-R1`)
- One of the following authentication methods (resolved automatically by `DefaultAzureCredential`):
  - `az login` for local development
  - Environment variables (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`) for a service principal
  - Managed identity or workload identity for Azure-hosted compute

---

## Quick start

```ts
import { createAzureFoundry } from '@nquandt/azure-ai-sdk';
import { generateText } from 'ai';

const foundry = createAzureFoundry({
  endpoint: 'https://my-resource.cognitiveservices.azure.com',
});

const { text } = await generateText({
  model: foundry('gpt-4o'),
  prompt: 'Explain quantum entanglement in one paragraph.',
});

console.log(text);
```

---

## Endpoint formats

Two endpoint styles are supported and detected automatically from the hostname:

| Endpoint format | URL called | Model location |
|---|---|---|
| `https://<resource>.cognitiveservices.azure.com` | `/openai/deployments/{model}/chat/completions?api-version=...` | URL path |
| `https://<project>.services.ai.azure.com/models` | `/chat/completions` | Request body |

When routing through a gateway (e.g. APIM) whose hostname does not match
either pattern, use the `endpointStyle` option to override detection. See
[Using with APIM](#using-with-azure-api-management-apim) below.

---

## Authentication

By default the provider uses `DefaultAzureCredential` from `@azure/identity`, which tries the following in order:

1. Environment variables — `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
2. Workload identity (Kubernetes federated credentials)
3. Managed identity (Azure-hosted compute)
4. Azure CLI (`az login`)
5. Azure PowerShell
6. VS Code account

For local development, `az login` is all you need.

### Custom credential

Credential types are re-exported from the package so you don't need a direct `@azure/identity` dependency:

```ts
import { createAzureFoundry, ManagedIdentityCredential } from '@nquandt/azure-ai-sdk';

const foundry = createAzureFoundry({
  endpoint: 'https://my-resource.cognitiveservices.azure.com',
  credential: new ManagedIdentityCredential('<client-id>'),
});
```

### Service principal (CI / GitHub Actions)

Set these environment variables — `DefaultAzureCredential` picks them up automatically:

```bash
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<app-registration-client-id>
AZURE_CLIENT_SECRET=<client-secret>
```

---

## Configuration options

```ts
createAzureFoundry({
  // Required. Azure resource endpoint URL.
  // Can also be set via the AZURE_AI_FOUNDRY_ENDPOINT environment variable.
  endpoint: 'https://my-resource.cognitiveservices.azure.com',

  // Optional. Controls URL construction. Values: 'auto' | 'cognitive-services' | 'foundry'.
  // Defaults to 'auto' — infers style from the hostname.
  // Set explicitly when routing through a gateway whose hostname is not recognized.
  endpointStyle: 'auto',

  // Optional. API version query param (cognitive-services style only).
  // Defaults to '2024-10-21'.
  apiVersion: '2024-10-21',

  // Optional. Custom TokenCredential. Defaults to DefaultAzureCredential.
  credential: new ManagedIdentityCredential(),

  // Optional. OAuth2 scope. Defaults to 'https://cognitiveservices.azure.com/.default'.
  // For APIM: set to 'api://<apim-app-client-id>/.default'.
  scope: 'https://cognitiveservices.azure.com/.default',

  // Optional. Supplemental subscription key sent alongside the Entra bearer token.
  // Only needed when your APIM policy additionally requires a subscription key.
  // Entra auth is the primary mechanism — this is not a substitute for it.
  apiKey: process.env.APIM_SUBSCRIPTION_KEY,

  // Optional. Extra headers sent with every request. Take precedence over apiKey.
  headers: { 'x-custom-header': 'value' },
});
```

### Per-model settings

```ts
const model = foundry('gpt-4o', {
  maxTokens: 1024,
  temperature: 0.7,
  topP: 0.95,
});
```

---

## Usage examples

### Generate text

```ts
import { createAzureFoundry } from '@nquandt/azure-ai-sdk';
import { generateText } from 'ai';

const foundry = createAzureFoundry({
  endpoint: process.env.AZURE_AI_FOUNDRY_ENDPOINT,
});

const { text, usage } = await generateText({
  model: foundry('gpt-4o'),
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'What is the capital of France?' },
  ],
});
```

### Stream text

```ts
import { createAzureFoundry } from '@nquandt/azure-ai-sdk';
import { streamText } from 'ai';

const foundry = createAzureFoundry({
  endpoint: process.env.AZURE_AI_FOUNDRY_ENDPOINT,
});

const result = streamText({
  model: foundry('gpt-4o'),
  prompt: 'Write a haiku about mountains.',
});

for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

### Tool calling

```ts
import { createAzureFoundry } from '@nquandt/azure-ai-sdk';
import { generateText, tool } from 'ai';
import { z } from 'zod';

const foundry = createAzureFoundry({
  endpoint: process.env.AZURE_AI_FOUNDRY_ENDPOINT,
});

const { text } = await generateText({
  model: foundry('gpt-4o'),
  tools: {
    getWeather: tool({
      description: 'Get current weather for a city',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ temperature: 22, condition: 'sunny', city }),
    }),
  },
  prompt: 'What is the weather in London?',
});
```

### AI Foundry inference endpoint (serverless models)

```ts
const foundry = createAzureFoundry({
  endpoint: 'https://my-project.services.ai.azure.com/models',
});

const { text } = await generateText({
  model: foundry('DeepSeek-R1'),
  prompt: 'Solve: what is 17 * 23?',
});
```

---

## Environment variable

You can omit the `endpoint` option and set it via the environment instead:

```bash
AZURE_AI_FOUNDRY_ENDPOINT=https://my-resource.cognitiveservices.azure.com
```

```ts
// endpoint is read from AZURE_AI_FOUNDRY_ENDPOINT automatically
const foundry = createAzureFoundry({});
```

---

## Using with Azure API Management (APIM)

When Azure AI models are exposed through an APIM gateway rather than accessed
directly, three things need to be configured differently from a standard
Foundry/Cognitive Services connection.

### 1. Endpoint style

APIM hostnames (e.g. `my-org.azure-api.net`) are not automatically recognized
as Cognitive Services endpoints. If your APIM routes to an Azure OpenAI backend,
set `endpointStyle: 'cognitive-services'` explicitly so requests are sent to
`/openai/deployments/{model}/chat/completions?api-version=...`:

```ts
const foundry = createAzureFoundry({
  endpoint: 'https://my-org.azure-api.net',
  endpointStyle: 'cognitive-services',
});
```

> **Note:** Do not include `/openai` in the `endpoint` value. The provider
> appends `/openai/deployments/{model}/...` automatically. If a trailing
> `/openai` segment is present (a common copy-paste from APIM or Azure portal
> URLs), the provider strips it silently so the correct path is produced either
> way.

### 2. OAuth scope

APIM validates tokens against its **own Entra app registration**, not the
Cognitive Services resource. A token obtained for the default scope
(`https://cognitiveservices.azure.com/.default`) will be rejected by APIM's
JWT validation policy. Set `scope` to your APIM app registration's audience:

```ts
const foundry = createAzureFoundry({
  endpoint: 'https://my-org.azure-api.net',
  endpointStyle: 'cognitive-services',
  scope: 'api://<apim-app-client-id>/.default',
});
```

Your APIM instance must have a `validate-jwt` policy configured to accept tokens
from this audience and a backend policy to forward requests to the underlying
Azure OpenAI / Foundry resource.

### 3. Subscription key (if required by your APIM policy)

Entra bearer token authentication is the primary mechanism — `apiKey` is only
needed when your APIM product policy additionally requires a subscription key
alongside the token. Most well-configured APIM deployments validate the Entra
JWT alone and do not require a subscription key at all.

If your specific APIM policy does require one:

```ts
const foundry = createAzureFoundry({
  endpoint: 'https://my-org.azure-api.net',
  endpointStyle: 'cognitive-services',
  scope: 'api://<apim-app-client-id>/.default',
  apiKey: process.env.APIM_SUBSCRIPTION_KEY,  // supplement to Entra auth, not a replacement
});
```

The `apiKey` value is sent as both `Ocp-Apim-Subscription-Key` (APIM) and
`api-key` (Azure OpenAI / Cognitive Services compatibility) headers alongside
the Entra bearer token. Values in `headers` take precedence if the same key
appears in both.

### OpenCode config example

```json
{
  "provider": {
    "azure-foundry": {
      "npm": "@nquandt/azure-ai-sdk",
      "name": "Azure AI Foundry (APIM)",
      "options": {
        "endpoint": "https://my-org.azure-api.net",
        "endpointStyle": "cognitive-services",
        "scope": "api://<apim-app-client-id>/.default"
      },
      "models": {
        "gpt-4o": {
          "name": "GPT-4o",
          "limit": { "context": 128000, "output": 16384 }
        }
      }
    }
  }
}
```

---

## Integration tests

Integration tests in `test/chat.test.ts` are skipped automatically unless the required environment variables are set:

```bash
cp .env.example .env
# fill in AZURE_FOUNDRY_ENDPOINT and AZURE_FOUNDRY_MODEL, then:
az login
npm test
```

The unit tests (`provider`, `generate`, `stream`) run entirely with in-memory mocks and require no Azure access.

---

## Further reading

- [Using with OpenCode](docs/opencode.md)
- [APIM integration](docs/apim-integration.md)
- [Custom provider reference](docs/custom-provider.md)

---

## License

MIT

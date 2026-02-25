# APIM Integration

This document describes how to use `@nquandt/azure-ai-sdk` with an Azure API Management (APIM) gateway that proxies Azure AI Foundry endpoints.

---

## How the SDK authenticates

The provider uses `DefaultAzureCredential` (or any `TokenCredential` you supply) to obtain a Bearer token for every request. The default OAuth2 scope depends on the endpoint type:

| Endpoint type | Default scope |
|---|---|
| `*.cognitiveservices.azure.com` | `https://cognitiveservices.azure.com/.default` |
| `*.services.ai.azure.com/models` | `https://cognitiveservices.azure.com/.default` |
| Custom (APIM, etc.) | Set the `scope` option on `createAzureFoundry` |

---

## Basic APIM setup

Point the SDK at your APIM gateway URL and, if your gateway validates a custom app registration audience, pass the matching scope:

```ts
import { createAzureFoundry } from '@nquandt/azure-ai-sdk';

const foundry = createAzureFoundry({
  endpoint: 'https://<your-apim>.azure-api.net/openai',
  scope: 'api://<your-app-registration-client-id>/.default',
});
```

For local development, authenticate first with the Azure CLI:

```bash
az login
az account get-access-token --scope "api://<your-app-registration-client-id>/.default"
```

`DefaultAzureCredential` resolves the token automatically at runtime — no additional credential configuration is needed beyond being logged in to the correct tenant.

---

## APIM JWT validation policy

A common APIM pattern is a `validate-jwt` policy that restricts which token audiences are accepted. If your policy only allows your app registration's audience, tokens from `DefaultAzureCredential` using the standard Azure AI scopes will be rejected.

To allow callers to use the SDK without a custom `scope` option, add the standard Azure AI audiences to your `validate-jwt` policy:

```xml
<audiences>
  <audience>{{entra-client-id}}</audience>
  <audience>api://{{entra-client-id}}</audience>
  <!-- Allow standard Azure AI scopes so DefaultAzureCredential works out of the box -->
  <audience>https://cognitiveservices.azure.com</audience>
  <audience>https://ai.azure.com</audience>
</audiences>
```

**Why these two audiences:**

- `https://cognitiveservices.azure.com` — the scope Azure AI Foundry itself validates, and what `DefaultAzureCredential` requests by default when the SDK's default scope is used.
- `https://ai.azure.com` — the newer Azure AI platform scope, also accepted directly by Azure AI Foundry.

Both are tenant-scoped — if your `issuers` block already restricts to your tenant ID, accepting these audiences does not open the gateway to tokens from other tenants.

---

## URL routing through APIM

The SDK infers the URL format from the endpoint hostname:

| Endpoint hostname | URL pattern | Model sent in |
|---|---|---|
| `*.cognitiveservices.azure.com` | `/openai/deployments/{model}/chat/completions?api-version=...` | URL path |
| `*.services.ai.azure.com` | `/chat/completions` | Request body |
| **Anything else (APIM, custom)** | `/openai/deployments/{model}/chat/completions?api-version=...` | URL path |

APIM hostnames fall into the "anything else" category and default to the deployment-path style. Make sure your APIM API is configured with a matching operation path (`/deployments/{deployment-id}/chat/completions`).

### Unified routing endpoint

If your APIM gateway exposes a unified routing endpoint that accepts a `model` field in the request body (similar to the AI Foundry serverless style), append the deployment path to your endpoint so the SDK sends the model in the body instead:

```ts
const foundry = createAzureFoundry({
  endpoint: 'https://<your-apim>.azure-api.net/openai/deployments/unified',
  // SDK detects no deployment path to substitute and sends model in request body
});
```

---

## Adapter type behind APIM

When a deployment name in APIM doesn't match the underlying model family name, the SDK's automatic adapter detection won't work. Set `adapterType` explicitly per model:

```ts
const foundry = createAzureFoundry({
  endpoint: 'https://<your-apim>.azure-api.net/openai',
  scope: 'api://<your-app-registration-client-id>/.default',
});

// Deployment is named "my-chat-model" but it's backed by gpt-4o
const model = foundry('my-chat-model', { adapterType: 'openai-legacy' });
```

See the main README for the full list of adapter types.

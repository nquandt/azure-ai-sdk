# APIM Integration

This document describes what is required to use `@nquandt/azure-ai-sdk` with an Azure API Management (APIM)
instance that proxies Azure AI Foundry endpoints, and the specific changes needed to the `naq-testai-eus-apim`
gateway before the SDK can authenticate successfully against it.

## How the SDK authenticates

The provider uses `DefaultAzureCredential` (or any `TokenCredential` you supply) with a fixed OAuth2 scope to
obtain a Bearer token for every request:

| Endpoint type | Default scope |
|---|---|
| `*.cognitiveservices.azure.com` | `https://cognitiveservices.azure.com/.default` |
| `*.services.ai.azure.com/models` | `https://cognitiveservices.azure.com/.default` |
| Custom (APIM, etc.) | Pass `scope` option to `createAzureFoundry` |

When targeting APIM, the scope can be overridden:

```ts
const foundry = createAzureFoundry({
  endpoint: 'https://naq-testai-eus-apim.azure-api.net/openai',
  scope: 'https://ai.azure.com/.default', // or the app registration scope
});
```

## Current blockers

The `naq-testai-eus-apim` gateway has a `validate-jwt` policy (in the `ai-validate-entra-token` policy
fragment) that only accepts tokens with these audiences:

```xml
<audiences>
  <audience>{{entra-client-id}}</audience>       <!-- f909a0cd-5a8c-4dd0-a0db-8a2f85529fe1 -->
  <audience>api://{{entra-client-id}}</audience>
</audiences>
```

Neither of those is a scope that `DefaultAzureCredential` or `az login` will produce without extra
configuration. The two scopes those tools produce by default — and that Azure AI Foundry itself accepts —
are explicitly rejected by the current APIM policy.

### Required APIM policy change

Add the following two `<audience>` entries to the `ai-validate-entra-token` policy fragment so that tokens
obtained with either of the standard Azure AI scopes are accepted:

```xml
<audiences>
  <audience>{{entra-client-id}}</audience>
  <audience>api://{{entra-client-id}}</audience>
  <!-- Add these two so DefaultAzureCredential / az login works without a custom scope -->
  <audience>https://cognitiveservices.azure.com</audience>
  <audience>https://ai.azure.com</audience>
</audiences>
```

With this change, callers can use the SDK against APIM with zero extra configuration — the same
`createAzureFoundry({ endpoint })` call works for both direct Foundry and APIM.

### Why these two audiences

- `https://cognitiveservices.azure.com` — the scope Azure AI Foundry itself validates. This is what
  `DefaultAzureCredential` requests when the SDK default scope is used, and what `az account get-access-token`
  returns by default for Cognitive Services resources.
- `https://ai.azure.com` — the newer Azure AI platform scope. Also accepted by Azure AI Foundry directly.
  Confirmed working against `naq-test-ai-eus2-resource` in testing.

Both are tenant-scoped (the `issuers` block already restricts to `{{entra-tenant-id}}`), so accepting these
audiences does not open the gateway to tokens from other tenants.

## Workaround (until APIM is updated)

Pass the custom app registration scope explicitly when creating the provider:

```ts
import { createAzureFoundry } from '@nquandt/azure-ai-sdk';

const foundry = createAzureFoundry({
  endpoint: 'https://naq-testai-eus-apim.azure-api.net/openai',
  scope: 'api://f909a0cd-5a8c-4dd0-a0db-8a2f85529fe1/.default',
});
```

Callers using `az login` can get a token for this scope with:

```bash
az account get-access-token --scope "api://f909a0cd-5a8c-4dd0-a0db-8a2f85529fe1/.default"
```

`DefaultAzureCredential` will resolve this automatically at runtime — no additional credential configuration is
needed beyond being logged in to the correct tenant.

## APIM endpoint URL

The gateway base URL for the AI Gateway API is:

```
https://naq-testai-eus-apim.azure-api.net/openai
```

The SDK treats this as a cognitiveservices-style endpoint (deployment name in URL path) since the hostname does
not match `cognitiveservices.azure.com` or `services.ai.azure.com`. The URL format it will use is:

```
/openai/deployments/{modelId}/chat/completions?api-version=2024-10-21
```

This matches the `ChatCompletions_Create` operation registered on the APIM API
(`/deployments/{deployment-id}/chat/completions`).

The APIM gateway also exposes a unified routing endpoint at `/deployments/unified/chat/completions` that routes
by `model` in the request body. This maps to the `services.ai.azure.com/models` endpoint style in the SDK:

```ts
const foundry = createAzureFoundry({
  endpoint: 'https://naq-testai-eus-apim.azure-api.net/openai/deployments/unified',
  // ^ SDK will call /chat/completions and send model in the request body
});
```

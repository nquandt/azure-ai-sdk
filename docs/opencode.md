# Using with OpenCode

This SDK can be used as a custom provider in [OpenCode](https://opencode.ai), giving OpenCode access to any model deployed in Azure AI Foundry — authenticated via Azure Entra identity with no API keys.

---

## Setup

### 1. Authenticate with Azure

OpenCode runs as your local user, so `az login` is all that's needed for local development:

```bash
az login
```

For remote or headless environments, any credential supported by `DefaultAzureCredential` works (managed identity, workload identity, service principal env vars, etc.).

### 2. Create `opencode.json` in your project

Add the following to `opencode.json` at the root of your project, substituting your Azure endpoint and deployment name:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "azure-foundry": {
      "npm": "@nquandt/azure-ai-sdk",
      "name": "Azure AI Foundry",
      "options": {
        "endpoint": "https://<your-resource>.cognitiveservices.azure.com"
      },
      "models": {
        "gpt-4o": {
          "name": "GPT-4o"
        }
      }
    }
  },
  "model": "azure-foundry/gpt-4o"
}
```

OpenCode will install `@nquandt/azure-ai-sdk` from npm automatically on first run.

---

## Endpoint formats

Both Azure endpoint styles are supported and detected automatically:

| Endpoint | Style |
|---|---|
| `https://<resource>.cognitiveservices.azure.com` | Azure OpenAI / Cognitive Services |
| `https://<project>.services.ai.azure.com/models` | AI Foundry serverless inference |

---

## Multiple models

List as many models as you have deployed:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "azure-foundry": {
      "npm": "@nquandt/azure-ai-sdk",
      "name": "Azure AI Foundry",
      "options": {
        "endpoint": "https://<your-resource>.cognitiveservices.azure.com"
      },
      "models": {
        "gpt-4o": { "name": "GPT-4o" },
        "gpt-4o-mini": { "name": "GPT-4o Mini" },
        "DeepSeek-R1": { "name": "DeepSeek R1" }
      }
    }
  }
}
```

Switch between them with `/models` inside OpenCode.

---

## Choosing the right adapter

Different model families use different request payload formats. The SDK detects the correct adapter automatically from the model name, but when deploying behind APIM or a gateway where the deployment name doesn't match the underlying model, set `adapterType` explicitly per model:

| `adapterType` | Use for |
|---|---|
| `openai` | o-series, gpt-5+ (`max_completion_tokens`) |
| `openai-legacy` | gpt-4o, gpt-4, gpt-35-turbo (`max_tokens`) |
| `anthropic` | Claude models via Azure *(coming soon)* |

```json
{
  "models": {
    "my-apim-deployment": {
      "name": "GPT-4o via APIM",
      "options": {
        "adapterType": "openai-legacy"
      }
    }
  }
}
```

---

## Behind an APIM gateway

See [apim-integration.md](./apim-integration.md) for a full walkthrough of using this SDK with an Azure API Management gateway, including custom scopes and header forwarding.

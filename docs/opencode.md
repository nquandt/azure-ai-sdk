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

This repository ships `opencode.example.json` as a template. Copy it to `opencode.json` (that filename is gitignored here so you can keep keys or `az login` locally without committing secrets).

Add the following to `opencode.json` at the root of your project. Use either a full endpoint URL **or** supply `resourceName` + `projectId` and let the SDK construct the URL for you:

**Option A — resource + project (recommended)**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "azure-foundry": {
      "npm": "@nquandt/azure-ai-sdk",
      "name": "Azure AI Foundry",
      "options": {
        "resourceName": "<your-resource>",
        "projectId": "<your-project>"
      },
      "models": {
        "gpt-4o": { "name": "GPT-4o" }
      }
    }
  },
  "model": "azure-foundry/gpt-4o"
}
```

Constructs: `https://<your-resource>.services.ai.azure.com/api/projects/<your-project>`

**Option B — full endpoint URL**
```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "azure-foundry": {
      "npm": "@nquandt/azure-ai-sdk",
      "name": "Azure AI Foundry",
      "options": {
        "endpoint": "https://<your-resource>.openai.azure.com/openai/v1"
      },
      "models": {
        "gpt-4o": { "name": "GPT-4o" }
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
| `https://<resource>.openai.azure.com/openai/v1` | Azure OpenAI v1 (model in body) |
| `https://<project>.services.ai.azure.com/models` | AI Foundry serverless inference |

You can also provide `resourceName` and `projectId` instead of a full `endpoint` URL — the SDK constructs `https://{resourceName}.services.ai.azure.com/api/projects/{projectId}` automatically.

---

## Multiple models

List as many models as you have deployed. All models in the provider share the same `options` unless you need to override something per-model:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "azure-foundry": {
      "npm": "@nquandt/azure-ai-sdk",
      "name": "Azure AI Foundry",
      "options": {
        "resourceName": "<your-resource>",
        "projectId": "<your-project>",
        "apiKey": "<optional-key-if-not-using-az-login>"
      },
      "models": {
        "gpt-5.4-nano":     { "name": "GPT-5.4 Nano" },
        "gpt-4o":           { "name": "GPT-4o" },
        "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6" },
        "Kimi-K2.5":        { "name": "Kimi K2.5" },
        "DeepSeek-R1":      { "name": "DeepSeek R1" }
      }
    }
  }
}
```

Switch between them with `/models` inside OpenCode.

---

## Adapter auto-detection

Different model families use different request/response wire formats. The SDK detects the correct adapter automatically from the model name:

| `adapterType` | Auto-detected patterns | Use for |
|---|---|---|
| `openai` | `o1`, `o3`, `gpt-5*`, `gpt-4.5*` | o-series, gpt-5+ (`max_completion_tokens`) |
| `openai-legacy` | `gpt-4o*`, `gpt-4*`, `gpt-35*`, `gpt-3.5*`, `kimi*` | gpt-4o, gpt-4, Kimi K2.5 (`max_tokens`) |
| `anthropic` | `claude*` | Claude models — routes to `/anthropic/v1/messages` |

As long as your deployment name matches one of the patterns above (e.g. `claude-sonnet-4-6`, `Kimi-K2.5`), no extra config is needed.

### Forcing an adapter

When the deployment name in your project doesn’t match the underlying model family — common behind APIM or when using custom deployment names — set `adapterType` explicitly on the model:

```json
{
  "provider": {
    "azure-foundry": {
      "npm": "@nquandt/azure-ai-sdk",
      "name": "Azure AI Foundry",
      "options": {
        "resourceName": "<your-resource>",
        "projectId": "<your-project>"
      },
      "models": {
        "my-gpt4o-deployment": {
          "name": "GPT-4o (custom name)",
          "options": { "adapterType": "openai-legacy" }
        },
        "my-claude-deployment": {
          "name": "Claude (custom name)",
          "options": { "adapterType": "anthropic" }
        },
        "my-o3-deployment": {
          "name": "o3 (custom name)",
          "options": { "adapterType": "openai" }
        }
      }
    }
  }
}
```

---

## Behind an APIM gateway

See [apim-integration.md](./apim-integration.md) for a full walkthrough of using this SDK with an Azure API Management gateway, including custom scopes and header forwarding.

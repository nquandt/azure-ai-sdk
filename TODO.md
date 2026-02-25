# AI SDK v5 Migration TODO

The provider implementation has been migrated to `LanguageModelV2` / `@ai-sdk/provider@3`.
The source typechecks clean. The items below are the remaining test and integration failures.

---

## 1. Update `test/generate.test.ts`

The tests still use the V1 call shape and assert V1 response fields.

### Call options to fix everywhere in this file

- Remove `inputFormat: 'messages'` — not part of `LanguageModelV2CallOptions`
- Remove `mode: { type: 'regular' }` — V2 has no `mode`; tools/toolChoice are top-level
- `maxTokens: 512` → `maxOutputTokens: 512`

### Tests that pass tools/toolChoice

Old shape:
```ts
mode: {
  type: 'regular',
  tools: [{ type: 'function', name: '...', description: '...', parameters: {...} }],
  toolChoice: { type: 'auto' },
}
```
New shape (top-level, `parameters` renamed to `inputSchema`):
```ts
tools: [{ type: 'function', name: '...', description: '...', inputSchema: {...} }],
toolChoice: { type: 'auto' },
```

### Test that passes JSON mode

Old: `mode: { type: 'object-json', schema: {}, name: undefined, description: undefined }`
New: `responseFormat: { type: 'json' }`

### Response field assertions to fix

| Old | New |
|-----|-----|
| `result.text` | `result.content.find(p => p.type === 'text')?.text` |
| `result.toolCalls` | `result.content.filter(p => p.type === 'tool-call')` |
| `result.toolCalls[0].toolCallType` | removed — no such field in V2 |
| `result.toolCalls[0].toolCallId` | `result.content[i].toolCallId` |
| `result.toolCalls[0].toolName` | `result.content[i].toolName` |
| `result.toolCalls[0].args` | `result.content[i].input` (string) |
| `result.usage.promptTokens` | `result.usage.inputTokens` |
| `result.usage.completionTokens` | `result.usage.outputTokens` |
| `result.rawCall.rawPrompt` | `result.request?.body` |

---

## 2. Update `test/stream.test.ts`

### Call options (same as generate)

- Remove `inputFormat` and `mode` everywhere
- Update tool tests to pass `tools`/`toolChoice` at top level with `inputSchema`

### Import fix

```ts
// old
import type { LanguageModelV1StreamPart } from '@ai-sdk/provider';
// new
import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
```

And update the `parts` array type in `collectStream`.

### Stream part shape changes

| Old part | New part(s) |
|----------|-------------|
| `{ type: 'text-delta', textDelta: '...' }` | `{ type: 'text-start', id }` then `{ type: 'text-delta', id, delta: '...' }` then `{ type: 'text-end', id }` |
| `{ type: 'tool-call-delta', toolCallId, toolName, argsTextDelta }` | `{ type: 'tool-input-start', id, toolName }` then `{ type: 'tool-input-delta', id, delta }` |
| `{ type: 'tool-call', toolCallType, toolCallId, toolName, args }` | `{ type: 'tool-call', toolCallId, toolName, input }` — no `toolCallType`, `args` → `input` |
| `finish.usage.promptTokens` | `finish.usage.inputTokens` |
| `finish.usage.completionTokens` | `finish.usage.outputTokens` |

Usage can now be `undefined` when the API doesn't return it mid-stream. The test
`'finish usage defaults to zero when not in stream'` should be updated to expect
`{ inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }`.

Warnings are no longer in the `doStream` return value — they come as the first stream
part: `{ type: 'stream-start', warnings: [...] }`. Any test checking `result.warnings`
directly needs to read from the stream instead.

---

## 3. Update `test/provider.test.ts`

The `doGenerate` calls used in URL/auth tests still pass `inputFormat` and `mode`.
Fix them the same way as `generate.test.ts` (remove `inputFormat`, remove `mode`).

---

## 4. Update `test/chat.test.ts` (integration tests)

The integration tests call `generateText` / `streamText` from the `ai` package.
The devDependency is currently `ai@^4`, which rejects `specificationVersion: 'v2'` models:

```
AI_UnsupportedModelVersionError: AI SDK 4 only supports models that implement
specification version "v1". Please upgrade to AI SDK 5 to use this model.
```

Fix: upgrade the `ai` devDependency to v5:

```bash
npm install --save-dev ai@5
```

The `generateText` / `streamText` API surface is largely unchanged in v5 for basic use,
but verify the import path still works (`from 'ai'`).

---

## 5. Update `package.json` peer dependency

The `peerDependencies` entry currently allows `ai >= 4`. Since the model now implements
`specificationVersion: 'v2'`, callers need AI SDK v5+:

```json
"peerDependencies": {
  "ai": ">=5.0.0"
}
```

---

## 6. Update `@ai-sdk/provider` and `@ai-sdk/provider-utils` version pins in `package.json`

These were upgraded in `node_modules` but `package.json` still records the old ranges.
Update them to reflect what was installed:

```json
"dependencies": {
  "@ai-sdk/provider": "^3.0.8",
  "@ai-sdk/provider-utils": "^4.0.15",
  ...
}
```

---

## Summary checklist

- [ ] `test/generate.test.ts` — remove `inputFormat`/`mode`, fix `maxTokens`, fix response field names
- [ ] `test/stream.test.ts` — remove `inputFormat`/`mode`, update import, fix part field names
- [ ] `test/provider.test.ts` — remove `inputFormat`/`mode` from inline `doGenerate` calls
- [ ] `test/chat.test.ts` — upgrade `ai` devDependency to v5
- [ ] `package.json` — update `peerDependencies` to `ai >= 5`, update `@ai-sdk/*` dependency ranges

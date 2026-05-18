# AI Agent Integration

Compact rules for AI agents integrating `@agentmeshkit/oauth-codex`.

## Purpose

Use this package to read, refresh, write, and redact Codex ChatGPT OAuth
`auth.json` credentials, then use those credentials for standard
`chatgpt.com/backend-api/*` requests. Do not use it for OpenAI API keys,
API-key auth, or interactive browser login.

Protocol risk: `https://chatgpt.com/backend-api/*` is not a public OpenAI API
contract and may change. Keep callers resilient to status, schema, and event
shape changes.

## Integration Path

Resolve a private Codex account directory, create the auth manager, and pass the
same `codexHome` to the Codex runner:

```ts
import {
  createCodexAuthManager,
  getDefaultCodexAccountHome,
  resolveCodexAccountsRoot,
} from '@agentmeshkit/oauth-codex';

const accountsRoot = resolveCodexAccountsRoot();
const codexHome = getDefaultCodexAccountHome(accountsRoot);
const auth = createCodexAuthManager({ codexHome, fetch });

const accessToken = await auth.getAccessToken();
const accountId = auth.getAccountId();

await runner.runTurn({
  prompt,
  cwd,
  codexHome,
  sandbox: 'read-only',
});
```

Default root is `codex-runtime/accounts` under `cwd`. Override with
`CODEX_ACCOUNTS_DIR`. Mount or copy only the required account directory.

`getAccessToken()` refreshes near expiry and coalesces concurrent refreshes.
Writes are atomic and use `0600` file permissions.

## Quota Snapshot

```ts
import { fetchCodexQuotaSnapshot } from '@agentmeshkit/oauth-codex';

const quota = await fetchCodexQuotaSnapshot({ auth, fetch });
```

Network access is caller-injected through `fetch`. Use fake `fetch` responses in
tests.

## Backend API Calls

```ts
import {
  CHATGPT_RESPONSES_URL,
  collectCodexResponsesText,
  fetchWithCodexAuth,
} from '@agentmeshkit/oauth-codex';

const resp = await fetchWithCodexAuth({
  auth,
  url: CHATGPT_RESPONSES_URL,
  init: {
    method: 'POST',
    body: JSON.stringify({ model: 'gpt-5-mini', stream: true, input }),
  },
  accept: 'text/event-stream',
  fetchImpl: fetch,
});

if (!resp.ok) throw new Error(`codex backend request failed: ${resp.status}`);
const text = await collectCodexResponsesText(resp.body);
```

`fetchWithCodexAuth` sets Codex CLI-compatible headers, includes
`Chatgpt-Account-Id` when available, and retries one 401 response after
`auth.refresh()`. It does not retry network errors, 429, or 5xx responses.

By default, the User-Agent version is resolved on the target machine. Set
`CODEX_CLI_USER_AGENT` to override the whole value, or `CODEX_CLI_VERSION` to
avoid probing `codex --version`. Without either env var, the package lazily runs
one cached `codex --version` probe and falls back to its packaged default if the
Codex CLI is unavailable.

`collectCodexResponsesText` only aggregates `response.output_item.done` message
items with `output_text` content. Do not depend on `response.output_text.delta`
for final title/text extraction.

## Direct File Helpers

```ts
import {
  readCodexAuthFile,
  writeCodexAuthFile,
  redactAuthJson,
} from '@agentmeshkit/oauth-codex';
```

Reads accept native nested Codex auth and flat imported auth. Writes produce the
nested `auth_mode: "chatgpt"` shape.

Only decode JWT payloads for display metadata. Claims are unverified and must
not drive authorization decisions.

## Secret Safety Rules

- Never print or log raw `auth.json`.
- Never commit auth files, real token fixtures, copied token snippets, or
  snapshots containing credential material.
- Never paste real tokens into tests, snapshots, prompts, or errors.
- Use `redactAuthJson()` or `sanitizeErrorMessage()` before diagnostics.
- Never log refresh request bodies, token response bodies, headers,
  `URLSearchParams`, or unredacted `CodexCredentials`.
- Do not store fallback credentials in `~/.codex/auth.json` unless explicitly
  repairing the global Codex CLI login.
- Mount only the needed account directory in containers.

## Fake-Token Testing

Tests must use fake JWTs and fake refresh tokens. Do not read a developer's
real `auth.json` in automated tests.

```ts
function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.fake-signature`;
}

writeCodexAuthFile(codexHome, {
  accessToken: fakeJwt({ exp: 4_102_444_800 }),
  refreshToken: 'fake-refresh-token',
});
```

Mock refresh and quota calls with injected `fetch`; assert that thrown errors do
not contain fake secrets before adding similar logic around real deployments.

## Agent Checklist

- Use `createCodexAuthManager` for access tokens; do not parse files ad hoc.
- Use `fetchWithCodexAuth` for direct `chatgpt.com/backend-api/*` calls.
- Use `collectCodexResponsesText` for Responses API text extraction.
- Use `fetchCodexQuotaSnapshot({ auth, fetch })` for quota/status checks.
- Redact before diagnostics and summaries.
- Keep account files out of source and images.
- Keep docs, tests, and examples on fake tokens only.

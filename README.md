# @agentmeshkit/oauth-codex

Safe TypeScript utilities for Codex ChatGPT OAuth `auth.json` files and
`chatgpt.com` backend API calls.

The package reads both native Codex nested auth files and flat imported auth
fixtures, refreshes access tokens through caller-injected `fetch`, writes
`auth.json` atomically with `0600` permissions, and exposes redacted diagnostics
for AgentMeshKit runtimes.

## Package Scope

Although the package name is `oauth-codex`, this package is now a client
toolkit for using Codex OAuth credentials with `chatgpt.com` backend APIs. It
provides:

- OAuth token management with `createCodexAuthManager`.
- Credential file reads and atomic writes with `readCodexAuthFile` and
  `writeCodexAuthFile`.
- Standard backend request helpers with `fetchWithCodexAuth` and
  `buildCodexBackendHeaders`.
- Responses API SSE parsing with `parseCodexResponsesStream` and
  `collectCodexResponsesText`.
- Quota/status querying with `fetchCodexQuotaSnapshot`.

Protocol risk: `https://chatgpt.com/backend-api/*` is not a public OpenAI API
contract and may change. Keep downstream callers prepared for protocol drift.

## Install

```sh
pnpm add @agentmeshkit/oauth-codex
```

## Basic Use

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
```

`createCodexAuthManager` refreshes shortly before JWT expiry. Concurrent refresh
calls are coalesced so only one OAuth request updates the file. Pass the same
`codexHome` to any Codex runner process that should use this account.

For quota/status UI, reuse the manager instead of reading tokens yourself:

```ts
import { fetchCodexQuotaSnapshot } from '@agentmeshkit/oauth-codex';

const quota = await fetchCodexQuotaSnapshot({ auth, fetch });
```

To call the Codex Responses endpoint, use the standard authenticated fetch
helper and parse the SSE body:

```ts
import {
  CHATGPT_RESPONSES_URL,
  collectCodexResponsesText,
  createCodexAuthManager,
  fetchWithCodexAuth,
} from '@agentmeshkit/oauth-codex';

const auth = createCodexAuthManager({ codexHome, fetch });
const resp = await fetchWithCodexAuth({
  auth,
  url: CHATGPT_RESPONSES_URL,
  init: {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5-mini',
      stream: true,
      instructions: 'You generate concise session titles.',
      input: [{ role: 'user', content: 'User question: ...\nAssistant reply: ...' }],
    }),
  },
  accept: 'text/event-stream',
  fetchImpl: fetch,
});

if (!resp.ok) throw new Error(`responses failed: ${resp.status}`);
const title = await collectCodexResponsesText(resp.body);
```

When no `userAgent` override is provided, backend helpers resolve the Codex CLI
version on the target machine. Precedence is `CODEX_CLI_USER_AGENT`, then
`CODEX_CLI_VERSION`, then a lazy cached `codex --version` probe, then the
packaged fallback `DEFAULT_CODEX_CLI_USER_AGENT`. The probe runs at most once per
process for the default path and adds no package dependency.

All network access is caller-injected through `fetch`, so unit tests can use
fake responses and do not need live OpenAI or ChatGPT calls.

## Public Helpers

Most callers only need:

- `resolveCodexAccountsRoot()` to locate `CODEX_ACCOUNTS_DIR` or the local
  `codex-runtime/accounts` fallback.
- `getDefaultCodexAccountHome(accountsRoot)` or
  `getCodexAccountHome(accountsRoot, label)` to resolve a Codex home directory.
- `createCodexAuthManager({ codexHome, fetch })` to read and refresh tokens.
- `fetchWithCodexAuth({ auth, url, fetchImpl })` for standard
  `chatgpt.com/backend-api/*` requests with one 401 refresh retry.
- `collectCodexResponsesText(resp.body)` to aggregate final message text from
  Responses API `response.output_item.done` events.
- `fetchCodexQuotaSnapshot({ auth, fetch })` to normalize quota data.

Lower-level helpers are available for importers and diagnostics:

- `readCodexAuthFile(codexHome)` normalizes supported `auth.json` shapes.
- `writeCodexAuthFile(codexHome, tokens)` writes nested Codex auth atomically.
- `refreshAccessToken(refreshToken, { fetch })` performs a single refresh.
- `buildCodexBackendHeaders(...)` builds Codex CLI-compatible backend headers.
- `resolveDefaultCodexCliUserAgent(...)`, `detectCodexCliVersion(...)`,
  `parseCodexCliVersion(...)`, and `buildCodexCliUserAgent(...)` support
  target-machine Codex CLI user-agent resolution.
- `parseCodexResponsesStream(body)` yields typed SSE events from Responses API
  streams.
- `redactAuthJson(value)` and `sanitizeErrorMessage(message, secrets)` prepare
  diagnostic output without token material.
- `decodeCodexTokenMetadata(...)` and related decode helpers parse unverified
  JWT payloads only for non-secret metadata such as account id, email, and plan.

## Supported auth.json Shapes

Native Codex ChatGPT auth:

```json
{
  "auth_mode": "chatgpt",
  "tokens": {
    "access_token": "fake-access-token",
    "refresh_token": "fake-refresh-token",
    "id_token": "fake-id-token",
    "account_id": "acct_fake"
  }
}
```

Flat imported auth:

```json
{
  "type": "codex",
  "access_token": "fake-access-token",
  "refresh_token": "fake-refresh-token",
  "email": "user@example.test",
  "plan": "plus"
}
```

Reads accept either shape. Writes always produce the nested
`auth_mode: "chatgpt"` shape expected by Codex.

## Account Directories

AgentMeshKit services should keep Codex accounts outside global `~/.codex`:

```text
codex-runtime/
  accounts/
    default/
      auth.json
```

Use `CODEX_ACCOUNTS_DIR` to override the accounts root:

```sh
CODEX_ACCOUNTS_DIR=/app/codex-runtime/accounts
```

Then use:

```ts
const accountsRoot = resolveCodexAccountsRoot();
const codexHome = getDefaultCodexAccountHome(accountsRoot);
```

Only the `default` account is assumed by the helper names. Additional labels can
be resolved with `getCodexAccountHome(accountsRoot, label)`.

## Local and Container Deployment

Local development:

```sh
mkdir -p codex-runtime/accounts/default
chmod 700 codex-runtime/accounts/default
# Place auth.json without printing it.
chmod 600 codex-runtime/accounts/default/auth.json
```

Container deployment:

```sh
docker run \
  -e CODEX_ACCOUNTS_DIR=/app/codex-runtime/accounts \
  -v "$PWD/codex-runtime/accounts:/app/codex-runtime/accounts:rw" \
  your-image
```

Mount only the account directory required by the service. Do not bake OAuth
files into images.

## Fallback Copy Rule

When a trusted deployment already has a working Codex OAuth file, copy that file
as a credential, not as text:

```sh
mkdir -p codex-runtime/accounts/default
scp user@trusted-host:/path/to/codex-runtime/accounts/default/auth.json \
  codex-runtime/accounts/default/auth.json
chmod 600 codex-runtime/accounts/default/auth.json
```

Do not print, parse, log, or commit the file contents. Do not copy fallback
credentials into `~/.codex/auth.json` unless explicitly repairing the global
Codex CLI login. Restart the process or container after replacing the file so
the auth manager reloads it.

## Quota Helper

`fetchCodexQuotaSnapshot` calls `https://chatgpt.com/backend-api/wham/usage`
with a caller-provided `fetch`. Tests use fake responses; the package does not
need live network access to test quota normalization.

## Secret Safety

- Never log credentials. Do not log raw `auth.json`, token response bodies,
  request headers, `URLSearchParams`, caught errors that may embed tokens, or
  `CodexCredentials` objects before redaction.
- Errors from refresh and quota requests are sanitized.
- `redactAuthJson` masks token fields recursively.
- Treat JWT metadata decoding as convenience only. The package does not verify
  token signatures and callers must not use decoded claims for authorization.
- Tests use fake JWTs and fake refresh tokens only.
- The package never reads or prints real OAuth tokens by itself.

Use a fake-token testing pattern for all parser, refresh, and manager tests:

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

Do not copy a developer's real `auth.json` into tests. Do not paste real token
values into snapshots, fixtures, CI variables, or failure output.

For AI-agent-oriented integration rules, see
[`docs/AI_AGENT_INTEGRATION.md`](docs/AI_AGENT_INTEGRATION.md).

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

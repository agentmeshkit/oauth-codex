# AI Agent Integration

Compact rules for AI agents integrating `@agentmeshkit/oauth-codex`.

## Purpose

Use this package to read, refresh, write, and redact Codex ChatGPT OAuth
`auth.json` credentials. Do not use it for OpenAI API keys, API-key auth, or
interactive browser login.

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
- Use `fetchCodexQuotaSnapshot({ auth, fetch })` for quota/status checks.
- Redact before diagnostics and summaries.
- Keep account files out of source and images.
- Keep docs, tests, and examples on fake tokens only.

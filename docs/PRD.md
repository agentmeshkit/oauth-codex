# PRD: AgentMeshKit OAuth Codex

## Summary

`@agentmeshkit/oauth-codex` provides safe utilities for using ChatGPT/Codex OAuth
credentials with Codex-backed agent applications. It parses, refreshes,
validates, and diagnoses `auth.json` without leaking secrets, and provides
shared helpers for calling `chatgpt.com/backend-api/*` with those credentials.

## Problem

AgentWeb needs Codex authentication in local, LAN, and container deployments.
The app currently owns auth file parsing, refresh-token handling, account home
selection, quota calls, Responses API calls, SSE parsing, and operational
fallback rules. These concerns will repeat across projects and are risky to
reimplement casually.

## Users

- Backend apps spawning Codex with per-account `CODEX_HOME`.
- Admin UIs showing account/quota status.
- Deployment scripts validating that Codex auth is present.

## Goals

- Read and validate Codex `auth.json` shapes.
- Refresh access tokens safely.
- Write updated auth atomically with private permissions.
- Expose redacted diagnostics and account metadata.
- Provide helpers for account home directories.
- Provide reusable backend request headers and one-shot 401 refresh retry.
- Provide Responses API SSE parsing and done-only text extraction.

## Non-Goals

- No interactive browser login in MVP.
- No token printing.
- No dependency on AgentWeb database.
- No runner process management.
- No high-level business wrapper for specific Responses API use cases.
- No full OpenAI Responses API type model.

## MVP Scope

- `readCodexAuthFile(codexHome)`.
- `refreshAccessToken(refreshToken, { fetch })`.
- `writeCodexAuthFile(codexHome, tokens)`.
- `createCodexAuthManager({ codexHome, fetch })`.
- Redaction helpers for logs/errors.
- Quota request helper with caller-provided `fetch`.
- Account home helpers for `CODEX_ACCOUNTS_DIR` and `default/auth.json`.

## 0.2 Scope

- `DEFAULT_CODEX_CLI_USER_AGENT`, `DEFAULT_CODEX_ORIGINATOR`, and
  `CHATGPT_RESPONSES_URL`.
- Target-machine Codex CLI user-agent resolution via `CODEX_CLI_USER_AGENT`,
  `CODEX_CLI_VERSION`, lazy cached `codex --version`, and packaged fallback.
- `buildCodexBackendHeaders(...)` for Codex CLI-compatible backend headers.
- `fetchWithCodexAuth(...)` for authenticated `chatgpt.com/backend-api/*`
  requests with one 401 refresh retry.
- `parseCodexResponsesStream(body)` for Responses API SSE events.
- `collectCodexResponsesText(body)` for aggregating final message text from
  `response.output_item.done`.
- `fetchCodexQuotaSnapshot` reuses shared header construction while preserving
  the `CodexBar` user agent.

## Public API Sketch

```ts
const auth = createCodexAuthManager({ codexHome });
const accessToken = await auth.getAccessToken();
const accountId = auth.getAccountId();
```

## Implemented API

- `readCodexAuthFile(codexHome)` returns normalized credentials from either
  native nested Codex auth (`auth_mode: "chatgpt"`, `tokens.*`) or flat imported
  auth (`access_token`, `refresh_token` at top level).
- `writeCodexAuthFile(codexHome, tokens)` writes the nested Codex shape, uses a
  temporary file plus rename, fsyncs best-effort, and sets `0600`.
- `refreshAccessToken(refreshToken, { fetch, now })` uses OpenAI's Codex OAuth
  client id and never requires live network in tests because callers can inject
  `fetch`.
- `createCodexAuthManager({ codexHome, fetch })` caches credentials, refreshes
  shortly before JWT expiry, coalesces concurrent refresh calls, writes the
  refreshed file, and exposes account id/email/plan accessors.
- `decodeAccountIdFromAccessToken`, `decodeEmailFromToken`,
  `decodePlanFromToken`, and `decodeCodexTokenMetadata` parse unverified JWT
  payloads only for non-secret metadata.
- `getCodexAccountHome`, `getDefaultCodexAccountHome`,
  `getCodexAuthFilePath`, `getDefaultCodexAuthFilePath`, and
  `resolveCodexAccountsRoot` encode the local/container account-directory
  convention.
- `redactToken`, `redactAuthJson`, and `sanitizeErrorMessage` provide defensive
  redaction for token fields, bearer strings, JWT-like strings, and known
  secret values.
- `fetchCodexQuotaSnapshot` is available for caller-injected quota requests and
  quota response normalization.
- `buildCodexBackendHeaders` builds Codex backend headers with bearer auth,
  Codex CLI identity defaults, optional account id, optional session id, and
  caller overrides.
- `resolveDefaultCodexCliUserAgent`, `detectCodexCliVersion`,
  `parseCodexCliVersion`, and `buildCodexCliUserAgent` support target-machine
  Codex CLI user-agent resolution without adding third-party dependencies.
- `fetchWithCodexAuth` reads token/account id from a `CodexAuthManager`,
  delegates to `fetch`, retries one 401 after `auth.refresh()`, and returns the
  raw `Response`.
- `parseCodexResponsesStream` yields typed SSE events and stops after
  `response.completed`.
- `collectCodexResponsesText` aggregates `output_text` content from message
  `response.output_item.done` events and throws if the stream closes before
  `response.completed`.

## Acceptance Criteria

- Tests cover nested Codex `auth_mode: chatgpt` files and flat imported files.
- Refresh writes use atomic file replacement and `0600` permissions.
- Error messages never include token material.
- Consumers can inject `fetch` for tests.
- Docs include local/container deployment patterns.
- Docs include a compact AI-agent integration contract that points agents to the
  auth manager, backend request helper, Responses SSE helper, quota helper,
  redaction helpers, Codex runner pairing, and fake-token testing rules.

## Operational Notes

- Runtime services should prefer `codex-runtime/accounts/default/auth.json` or
  an explicit `CODEX_ACCOUNTS_DIR` over the user's global `~/.codex`.
- Container deployments should mount the account directory at runtime and never
  bake OAuth files into images.
- Never log credentials. Logs and diagnostics must avoid raw `auth.json`
  content, OAuth request bodies, response bodies, headers, and credential
  objects unless they have passed through `redactAuthJson` or
  `sanitizeErrorMessage`.
- Fallback credential copies must be copied as files without printing, parsing,
  logging, or committing contents. Preserve `0600` permissions and restart the
  service after replacing `auth.json`.
- Tests and fixtures must use fake token strings only. Prefer locally generated
  fake JWTs with minimal claims plus fake refresh-token strings; never use a
  developer's real `auth.json`, real tokens, CI secrets, or snapshots containing
  credential material.
- `https://chatgpt.com/backend-api/*` is not a public API contract. Callers
  must be prepared for protocol drift and should keep failures explicit.
- `docs/AI_AGENT_INTEGRATION.md` is the canonical compact guide for automated
  coding agents. Keep it short, API-accurate, and focused on safe integration
  rather than product background.

## Milestones

1. Extract auth file parser and redaction tests.
2. Implement refresh manager with concurrency coalescing.
3. Add quota helper and docs.
4. Publish `0.1.0`.
5. Add shared backend request helpers, Responses SSE parsing, and publish
   `0.2.0`.

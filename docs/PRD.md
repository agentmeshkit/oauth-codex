# PRD: AgentMeshKit OAuth Codex

## Summary

`@agentmeshkit/oauth-codex` provides safe utilities for using ChatGPT/Codex OAuth
credentials with Codex-backed agent applications. It focuses on parsing,
refreshing, validating, and diagnosing `auth.json` without leaking secrets.

## Problem

AgentWeb needs Codex authentication in local, LAN, and container deployments.
The app currently owns auth file parsing, refresh-token handling, account home
selection, quota calls, and operational fallback rules. These concerns will
repeat across projects and are risky to reimplement casually.

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

## Non-Goals

- No interactive browser login in MVP.
- No token printing.
- No dependency on AgentWeb database.
- No runner process management.

## MVP Scope

- `readCodexAuthFile(codexHome)`.
- `refreshCodexAccessToken(refreshToken)`.
- `writeCodexAuthFile(codexHome, tokens)`.
- `createCodexAuthManager({ codexHome, fetch })`.
- Redaction helpers for logs/errors.
- Quota request helper with caller-provided `fetch`.

## Public API Sketch

```ts
const auth = createCodexAuthManager({ codexHome });
const accessToken = await auth.getAccessToken();
const accountId = auth.getAccountId();
```

## Acceptance Criteria

- Tests cover nested Codex `auth_mode: chatgpt` files and flat imported files.
- Refresh writes use atomic file replacement and `0600` permissions.
- Error messages never include token material.
- Consumers can inject `fetch` for tests.
- Docs include local/container deployment patterns.

## Milestones

1. Extract auth file parser and redaction tests.
2. Implement refresh manager with concurrency coalescing.
3. Add quota helper and docs.
4. Publish `0.1.0`.


import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCodexAuthManager,
  decodeAccountIdFromAccessToken,
  fetchCodexQuotaSnapshot,
  getCodexAccountHome,
  readCodexAuthFile,
  redactAuthJson,
  refreshAccessToken,
  resolveCodexAccountsRoot,
  sanitizeErrorMessage,
  writeCodexAuthFile,
} from './index.js';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function tmpCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-codex-test-'));
  tmpDirs.push(dir);
  return dir;
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.fake-signature`;
}

describe('auth.json parsing', () => {
  it('reads nested chatgpt Codex auth and decodes safe metadata', () => {
    const codexHome = tmpCodexHome();
    const accessToken = fakeJwt({
      exp: 4_102_444_800,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_fake_nested',
        chatgpt_plan_type: 'plus',
      },
    });
    const idToken = fakeJwt({ email: 'nested@example.test' });
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          access_token: accessToken,
          refresh_token: 'fake-refresh-nested',
          id_token: idToken,
        },
      }),
    );

    const auth = readCodexAuthFile(codexHome);

    expect(auth).toMatchObject({
      accessToken,
      refreshToken: 'fake-refresh-nested',
      accountId: 'acct_fake_nested',
      email: 'nested@example.test',
      plan: 'plus',
      shape: 'nested-chatgpt',
    });
  });

  it('reads flat imported Codex auth', () => {
    const codexHome = tmpCodexHome();
    const accessToken = fakeJwt({ email: 'flat-token@example.test' });
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        type: 'codex',
        email: 'flat@example.test',
        plan: 'pro',
        account_id: 'acct_flat_file',
        access_token: accessToken,
        refresh_token: 'fake-refresh-flat',
      }),
    );

    expect(readCodexAuthFile(codexHome)).toMatchObject({
      accessToken,
      refreshToken: 'fake-refresh-flat',
      accountId: 'acct_flat_file',
      email: 'flat@example.test',
      plan: 'pro',
      shape: 'flat-imported',
    });
  });
});

describe('auth.json writing', () => {
  it('writes atomically with private permissions and nested chatgpt shape', () => {
    const codexHome = tmpCodexHome();

    writeCodexAuthFile(codexHome, {
      accessToken: 'fake-access-written',
      refreshToken: 'fake-refresh-written',
      accountId: 'acct_written',
      email: 'written@example.test',
      plan: 'team',
    });

    const authPath = path.join(codexHome, 'auth.json');
    const mode = fs.statSync(authPath).mode & 0o777;
    const raw = JSON.parse(fs.readFileSync(authPath, 'utf8')) as Record<string, unknown>;

    expect(mode).toBe(0o600);
    expect(raw).toMatchObject({
      auth_mode: 'chatgpt',
      email: 'written@example.test',
      plan: 'team',
      tokens: {
        access_token: 'fake-access-written',
        refresh_token: 'fake-refresh-written',
        account_id: 'acct_written',
      },
    });
  });
});

describe('refresh', () => {
  it('posts OAuth refresh with injected fetch and redacts failed responses', async () => {
    const refreshSecret = 'fake-refresh-secret';
    const fetchMock = vi.fn(async () => {
      return new Response(`{"refresh_token":"${refreshSecret}"}`, {
        status: 401,
        statusText: 'Unauthorized',
      });
    });

    await expect(refreshAccessToken(refreshSecret, { fetch: fetchMock })).rejects.toThrow(
      '<redacted',
    );
    await expect(refreshAccessToken(refreshSecret, { fetch: fetchMock })).rejects.not.toThrow(
      refreshSecret,
    );
  });

  it('coalesces concurrent manager refreshes and writes refreshed credentials', async () => {
    const codexHome = tmpCodexHome();
    const now = 1_700_000_000_000;
    writeCodexAuthFile(codexHome, {
      accessToken: fakeJwt({ exp: Math.floor((now - 1_000) / 1000) }),
      refreshToken: 'fake-refresh-old',
      accountId: 'acct_coalesce',
    });

    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({
        access_token: fakeJwt({
          exp: Math.floor((now + 3_600_000) / 1000),
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_coalesce' },
        }),
        refresh_token: 'fake-refresh-new',
        expires_in: 3600,
      });
    });
    const manager = createCodexAuthManager({ codexHome, fetch: fetchMock, now: () => now });

    const [first, second, third] = await Promise.all([
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(readCodexAuthFile(codexHome)).toMatchObject({
      refreshToken: 'fake-refresh-new',
      accountId: 'acct_coalesce',
    });
  });
});

describe('metadata, redaction, account homes, and quota', () => {
  it('decodes account id only from safe JWT payload parsing', () => {
    const token = fakeJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_decode' },
    });
    expect(decodeAccountIdFromAccessToken(token)).toBe('acct_decode');
    expect(decodeAccountIdFromAccessToken('not-a-jwt')).toBeUndefined();
  });

  it('redacts auth JSON and token-like error material', () => {
    const jwt = fakeJwt({ email: 'secret@example.test' });
    const redacted = redactAuthJson({
      tokens: { access_token: jwt, refresh_token: 'fake-refresh' },
      nested: { note: `Bearer ${jwt}` },
    });
    expect(JSON.stringify(redacted)).not.toContain(jwt);
    expect(sanitizeErrorMessage(`failed with token=${jwt}`)).not.toContain(jwt);
  });

  it('resolves account home helpers without touching the network', () => {
    expect(getCodexAccountHome('/tmp/accounts', 'default')).toBe('/tmp/accounts/default');
    expect(() => getCodexAccountHome('/tmp/accounts', '../bad')).toThrow('invalid Codex account label');
    expect(
      resolveCodexAccountsRoot({
        env: { CODEX_ACCOUNTS_DIR: '/tmp/custom-accounts' },
        cwd: '/workspace/app',
      }),
    ).toBe('/tmp/custom-accounts');
    expect(resolveCodexAccountsRoot({ env: {}, cwd: '/workspace/app' })).toBe(
      '/workspace/app/codex-runtime/accounts',
    );
  });

  it('fetches quota only through caller-provided fetch', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        plan_type: 'plus',
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 10,
            limit_window_seconds: 18_000,
            reset_after_seconds: 300,
            reset_at: 1_700_001_000,
          },
        },
      }),
    );

    const quota = await fetchCodexQuotaSnapshot({
      accessToken: 'fake-access',
      accountId: 'acct_fake',
      fetch: fetchMock,
      now: () => 1_700_000_000_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(quota.plan).toBe('plus');
    expect(quota.windows[0]).toMatchObject({ label: '5h', usedPercent: 10 });
  });
});

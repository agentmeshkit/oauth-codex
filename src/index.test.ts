import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCodexBackendHeaders,
  buildCodexCliUserAgent,
  CHATGPT_RESPONSES_URL,
  collectCodexResponsesText,
  type CodexAuthManager,
  createCodexAuthManager,
  DEFAULT_CODEX_CLI_USER_AGENT,
  DEFAULT_CODEX_ORIGINATOR,
  detectCodexCliVersion,
  decodeAccountIdFromAccessToken,
  FALLBACK_CODEX_CLI_VERSION,
  fetchCodexQuotaSnapshot,
  fetchWithCodexAuth,
  getCodexAccountHome,
  parseCodexCliVersion,
  parseCodexResponsesStream,
  readCodexAuthFile,
  redactAuthJson,
  refreshAccessToken,
  resolveDefaultCodexCliUserAgent,
  resolveCodexAccountsRoot,
  sanitizeErrorMessage,
  writeCodexAuthFile,
} from './index.js';

const tmpDirs: string[] = [];
const originalCodexCliUserAgent = process.env.CODEX_CLI_USER_AGENT;
const originalCodexCliVersion = process.env.CODEX_CLI_VERSION;

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  restoreEnv('CODEX_CLI_USER_AGENT', originalCodexCliUserAgent);
  restoreEnv('CODEX_CLI_VERSION', originalCodexCliVersion);
  vi.restoreAllMocks();
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function tmpCodexHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-codex-test-'));
  tmpDirs.push(dir);
  return dir;
}

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.fake-signature`;
}

function sseLine(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n`;
}

function streamFromChunks(chunks: string[], close = true): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
}

function fakeAuthManager(opts: {
  accessToken?: string;
  refreshedToken?: string;
  accountId?: string;
} = {}): CodexAuthManager {
  const credentials = {
    accessToken: opts.accessToken ?? 'fake-access',
    refreshToken: 'fake-refresh',
    authPath: 'auth.json',
    shape: 'nested-chatgpt' as const,
  };
  return {
    getAccessToken: vi.fn(async () => opts.accessToken ?? 'fake-access'),
    refresh: vi.fn(async () => opts.refreshedToken ?? 'fake-refreshed-access'),
    getCredentials: () => credentials,
    getAccountId: () => opts.accountId ?? 'acct_fake',
    getEmail: () => undefined,
    getPlan: () => undefined,
  };
}

describe('auth.json parsing', () => {
  it('returns null for malformed auth.json content', () => {
    const invalidJsonHome = tmpCodexHome();
    fs.writeFileSync(path.join(invalidJsonHome, 'auth.json'), '{not-json');

    const arrayJsonHome = tmpCodexHome();
    fs.writeFileSync(path.join(arrayJsonHome, 'auth.json'), '[]');

    expect(readCodexAuthFile(invalidJsonHome)).toBeNull();
    expect(readCodexAuthFile(arrayJsonHome)).toBeNull();
  });

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

  it('returns null when required token fields are missing', () => {
    const nestedMissingRefreshHome = tmpCodexHome();
    fs.writeFileSync(
      path.join(nestedMissingRefreshHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { access_token: 'fake-access-only' },
      }),
    );

    const nestedMissingAccessHome = tmpCodexHome();
    fs.writeFileSync(
      path.join(nestedMissingAccessHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: { refresh_token: 'fake-refresh-only' },
      }),
    );

    const flatMissingRefreshHome = tmpCodexHome();
    fs.writeFileSync(
      path.join(flatMissingRefreshHome, 'auth.json'),
      JSON.stringify({
        type: 'codex',
        access_token: 'fake-flat-access-only',
      }),
    );

    expect(readCodexAuthFile(nestedMissingRefreshHome)).toBeNull();
    expect(readCodexAuthFile(nestedMissingAccessHome)).toBeNull();
    expect(readCodexAuthFile(flatMissingRefreshHome)).toBeNull();
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

  it('does not retain flat top-level token fields when rewriting existing auth', () => {
    const codexHome = tmpCodexHome();
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({
        type: 'codex',
        access_token: 'fake-old-access',
        refresh_token: 'fake-old-refresh',
        id_token: 'fake-old-id',
        account_id: 'acct_old',
        expires_at: 1_700_000_000_000,
        email: 'existing@example.test',
      }),
    );

    writeCodexAuthFile(codexHome, {
      accessToken: 'fake-new-access',
      refreshToken: 'fake-new-refresh',
      idToken: 'fake-new-id',
      accountId: 'acct_new',
      expiresAt: 1_800_000_000_000,
    });

    const raw = JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')) as Record<
      string,
      unknown
    >;

    expect(raw.access_token).toBeUndefined();
    expect(raw.refresh_token).toBeUndefined();
    expect(raw.id_token).toBeUndefined();
    expect(raw.account_id).toBeUndefined();
    expect(raw.expires_at).toBeUndefined();
    expect(raw.tokens).toMatchObject({
      access_token: 'fake-new-access',
      refresh_token: 'fake-new-refresh',
      id_token: 'fake-new-id',
      account_id: 'acct_new',
      expires_at: 1_800_000_000_000,
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

  it('redacts token fields from HTTP error bodies', async () => {
    const refreshSecret = 'fake-refresh-request-secret';
    const leakedAccess = 'fake-access-from-error-body';
    const leakedRefresh = 'fake-refresh-from-error-body';
    const leakedAuthorization = 'fake-authorization-from-error-body';
    const leakedQuery = 'fake-query-token';
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: 'invalid_grant',
          access_token: leakedAccess,
          refresh_token: leakedRefresh,
          authorization: leakedAuthorization,
          detail: `refresh=${leakedQuery}`,
        }),
        { status: 400, statusText: 'Bad Request' },
      );
    });

    await expect(refreshAccessToken(refreshSecret, { fetch: fetchMock })).rejects.toThrow(
      '<redacted>',
    );
    await expect(refreshAccessToken(refreshSecret, { fetch: fetchMock })).rejects.not.toThrow(
      leakedAccess,
    );
    await expect(refreshAccessToken(refreshSecret, { fetch: fetchMock })).rejects.not.toThrow(
      leakedRefresh,
    );
    await expect(refreshAccessToken(refreshSecret, { fetch: fetchMock })).rejects.not.toThrow(
      leakedAuthorization,
    );
    await expect(refreshAccessToken(refreshSecret, { fetch: fetchMock })).rejects.not.toThrow(
      leakedQuery,
    );
    await expect(refreshAccessToken(refreshSecret, { fetch: fetchMock })).rejects.not.toThrow(
      refreshSecret,
    );
  });

  it('rejects refresh responses missing required fields without leaking returned token material', async () => {
    const returnedAccess = 'fake-access-without-refresh';
    const fetchMock = vi.fn(async () =>
      Response.json({
        access_token: returnedAccess,
        expires_in: 3600,
      }),
    );

    await expect(refreshAccessToken('fake-refresh-missing-fields', { fetch: fetchMock })).rejects.toThrow(
      'response missing required fields',
    );
    await expect(
      refreshAccessToken('fake-refresh-missing-fields', { fetch: fetchMock }),
    ).rejects.not.toThrow(returnedAccess);
  });

  it('manager returns unexpired tokens without refreshing', async () => {
    const codexHome = tmpCodexHome();
    const now = 1_700_000_000_000;
    const accessToken = fakeJwt({ exp: Math.floor((now + 3_600_000) / 1000) });
    writeCodexAuthFile(codexHome, {
      accessToken,
      refreshToken: 'fake-refresh-unexpired',
      accountId: 'acct_unexpired',
    });
    const fetchMock = vi.fn(async () => Response.json({}));
    const manager = createCodexAuthManager({ codexHome, fetch: fetchMock, now: () => now });

    await expect(manager.getAccessToken()).resolves.toBe(accessToken);
    expect(fetchMock).not.toHaveBeenCalled();
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

describe('Codex CLI user agent resolution', () => {
  it('parses codex CLI versions from command output', () => {
    expect(parseCodexCliVersion('codex-cli 0.130.0\n')).toBe('0.130.0');
    expect(parseCodexCliVersion('codex 0.131.1-beta.1\n')).toBe('0.131.1-beta.1');
    expect(parseCodexCliVersion('unexpected')).toBeUndefined();
  });

  it('builds a codex_cli_rs user agent from a version', () => {
    expect(buildCodexCliUserAgent('0.131.0')).toBe(
      'codex_cli_rs/0.131.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9',
    );
  });

  it('uses CODEX_CLI_VERSION before shelling out', () => {
    expect(detectCodexCliVersion({ env: { CODEX_CLI_VERSION: '9.8.7' } })).toBe('9.8.7');
    expect(
      resolveDefaultCodexCliUserAgent({
        env: { CODEX_CLI_VERSION: '9.8.7' },
        fallbackUserAgent: 'fallback',
      }),
    ).toBe('codex_cli_rs/9.8.7 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9');
  });

  it('uses CODEX_CLI_USER_AGENT as the highest precedence override', () => {
    expect(
      resolveDefaultCodexCliUserAgent({
        env: {
          CODEX_CLI_USER_AGENT: 'custom-target-ua',
          CODEX_CLI_VERSION: '9.8.7',
        },
      }),
    ).toBe('custom-target-ua');
  });

  it('falls back to the packaged default when codex cannot be detected', () => {
    expect(
      resolveDefaultCodexCliUserAgent({
        env: {},
        codexCommand: '/definitely/not/a/codex/binary',
        fallbackUserAgent: 'fallback-ua',
      }),
    ).toBe('fallback-ua');
    expect(DEFAULT_CODEX_CLI_USER_AGENT).toBe(buildCodexCliUserAgent(FALLBACK_CODEX_CLI_VERSION));
  });
});

describe('Codex backend headers', () => {
  it('uses codex CLI identity defaults and generates a Mac session id', () => {
    process.env.CODEX_CLI_USER_AGENT = DEFAULT_CODEX_CLI_USER_AGENT;
    const headers = buildCodexBackendHeaders({ accessToken: 'fake-access' });

    expect(headers.Authorization).toBe('Bearer fake-access');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['User-Agent']).toBe(DEFAULT_CODEX_CLI_USER_AGENT);
    expect(headers.Originator).toBe(DEFAULT_CODEX_ORIGINATOR);
    expect(headers.Accept).toBe('application/json');
    expect(headers.Session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('does not add Session_id for the CodexBar quota user agent', () => {
    const headers = buildCodexBackendHeaders({
      accessToken: 'fake-access',
      userAgent: 'CodexBar',
    });

    expect(headers['User-Agent']).toBe('CodexBar');
    expect(headers.Session_id).toBeUndefined();
  });

  it('omits account id when missing and includes it when provided', () => {
    expect(buildCodexBackendHeaders({ accessToken: 'fake-access' })['Chatgpt-Account-Id']).toBeUndefined();
    expect(
      buildCodexBackendHeaders({
        accessToken: 'fake-access',
        accountId: 'abc',
      })['Chatgpt-Account-Id'],
    ).toBe('abc');
  });

  it('lets extra headers override defaults case-insensitively', () => {
    const headers = buildCodexBackendHeaders({
      accessToken: 'fake-access',
      accountId: 'acct_fake',
      sessionId: 'caller-session',
      extra: {
        accept: 'text/event-stream',
        Authorization: 'Bearer override',
        'User-Agent': 'CustomUA',
        Session_id: 'extra-session',
      },
    });

    expect(headers.Accept).toBeUndefined();
    expect(headers.accept).toBe('text/event-stream');
    expect(headers.Authorization).toBe('Bearer override');
    expect(headers['User-Agent']).toBe('CustomUA');
    expect(headers.Session_id).toBe('extra-session');
  });
});

describe('fetchWithCodexAuth', () => {
  it('returns a 200 response and sends standard Codex backend headers', async () => {
    process.env.CODEX_CLI_USER_AGENT = DEFAULT_CODEX_CLI_USER_AGENT;
    const auth = fakeAuthManager({ accessToken: 'fake-access', accountId: 'acct_123' });
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));

    const resp = await fetchWithCodexAuth({
      auth,
      url: CHATGPT_RESPONSES_URL,
      fetchImpl: fetchMock,
    });

    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fake-access');
    expect(headers['User-Agent']).toBe(DEFAULT_CODEX_CLI_USER_AGENT);
    expect(headers.Originator).toBe(DEFAULT_CODEX_ORIGINATOR);
    expect(headers['Chatgpt-Account-Id']).toBe('acct_123');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const auth = fakeAuthManager({
      accessToken: 'fake-access-old',
      refreshedToken: 'fake-access-new',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const resp = await fetchWithCodexAuth({
      auth,
      url: CHATGPT_RESPONSES_URL,
      fetchImpl: fetchMock,
    });

    expect(resp.status).toBe(200);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer fake-access-new');
  });

  it('returns the second 401 response without throwing', async () => {
    const auth = fakeAuthManager();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('still expired', { status: 401 }));

    const resp = await fetchWithCodexAuth({
      auth,
      url: CHATGPT_RESPONSES_URL,
      fetchImpl: fetchMock,
    });

    expect(resp.status).toBe(401);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refresh when retryOnUnauthorized is false', async () => {
    const auth = fakeAuthManager();
    const fetchMock = vi.fn(async () => new Response('expired', { status: 401 }));

    const resp = await fetchWithCodexAuth({
      auth,
      url: CHATGPT_RESPONSES_URL,
      retryOnUnauthorized: false,
      fetchImpl: fetchMock,
    });

    expect(resp.status).toBe(401);
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refresh 5xx responses', async () => {
    const auth = fakeAuthManager();
    const fetchMock = vi.fn(async () => new Response('server error', { status: 503 }));

    const resp = await fetchWithCodexAuth({
      auth,
      url: CHATGPT_RESPONSES_URL,
      fetchImpl: fetchMock,
    });

    expect(resp.status).toBe(503);
    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('propagates network errors without retrying', async () => {
    const auth = fakeAuthManager();
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(
      fetchWithCodexAuth({
        auth,
        url: CHATGPT_RESPONSES_URL,
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow('network down');
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes through init method/body and preserves custom request headers', async () => {
    const auth = fakeAuthManager();
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));

    await fetchWithCodexAuth({
      auth,
      url: CHATGPT_RESPONSES_URL,
      init: {
        method: 'POST',
        body: '{"stream":true}',
        headers: { 'X-Test': 'yes', Authorization: 'Bearer caller-will-not-win' },
      },
      extraHeaders: { Accept: 'text/event-stream' },
      fetchImpl: fetchMock,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"stream":true}');
    expect(headers['X-Test']).toBe('yes');
    expect(headers.Authorization).toBe('Bearer fake-access');
    expect(headers.Accept).toBe('text/event-stream');
  });
});

describe('Responses API SSE parsing', () => {
  it('yields a single completed event and then stops', async () => {
    const events = [];
    for await (const event of parseCodexResponsesStream(
      streamFromChunks([sseLine({ type: 'response.completed', response: { id: 'resp_1' } })]),
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: 'response.completed',
        data: { response: { id: 'resp_1' } },
      },
    ]);
  });

  it('parses events split across chunks', async () => {
    const first = 'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"hel';
    const second = 'lo"}]}}\n';
    const third = sseLine({ type: 'response.completed' });
    const events = [];

    for await (const event of parseCodexResponsesStream(streamFromChunks([first, second, third]))) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events[0]?.data.item).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'hello' }],
    });
  });

  it('ignores non-data lines', async () => {
    const events = [];
    for await (const event of parseCodexResponsesStream(
      streamFromChunks([
        'event: ignored\n',
        '\n',
        ': comment\n',
        sseLine({ type: 'response.completed' }),
      ]),
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('response.completed');
  });

  it('skips malformed JSON data lines and keeps parsing later events', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events = [];

    for await (const event of parseCodexResponsesStream(
      streamFromChunks(['data: {broken-json}\n', sseLine({ type: 'response.completed' })]),
    )) {
      events.push(event);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.type)).toEqual(['response.completed']);
  });

  it('ends immediately for a null body', async () => {
    const events = [];
    for await (const event of parseCodexResponsesStream(null)) {
      events.push(event);
    }

    expect(events).toEqual([]);
  });

  it('stops after response.completed even if the stream stays open', async () => {
    const events = [];
    for await (const event of parseCodexResponsesStream(
      streamFromChunks(
        [
          sseLine({ type: 'response.completed' }),
          sseLine({ type: 'response.output_item.done', item: { type: 'message' } }),
        ],
        false,
      ),
    )) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual(['response.completed']);
  });
});

describe('collectCodexResponsesText', () => {
  it('collects output_text from a message output_item.done event', async () => {
    const text = await collectCodexResponsesText(
      streamFromChunks([
        sseLine({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [{ type: 'output_text', text: 'Title' }],
          },
        }),
        sseLine({ type: 'response.completed' }),
      ]),
    );

    expect(text).toBe('Title');
  });

  it('concatenates multiple message output_text parts in event order', async () => {
    const text = await collectCodexResponsesText(
      streamFromChunks([
        sseLine({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [{ type: 'output_text', text: 'First ' }],
          },
        }),
        sseLine({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [
              { type: 'output_text', text: 'Second' },
              { type: 'output_text', text: ' Third' },
            ],
          },
        }),
        sseLine({ type: 'response.completed' }),
      ]),
    );

    expect(text).toBe('First Second Third');
  });

  it('skips non-message items and non-output_text content', async () => {
    const text = await collectCodexResponsesText(
      streamFromChunks([
        sseLine({
          type: 'response.output_item.done',
          item: { type: 'reasoning', content: [{ type: 'output_text', text: 'hidden' }] },
        }),
        sseLine({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [{ type: 'refusal', text: 'skip' }],
          },
        }),
        sseLine({
          type: 'response.output_text.delta',
          delta: 'ignored delta',
        }),
        sseLine({ type: 'response.completed' }),
      ]),
    );

    expect(text).toBe('');
  });

  it('throws when the stream closes before response.completed', async () => {
    await expect(
      collectCodexResponsesText(
        streamFromChunks([
          sseLine({
            type: 'response.output_item.done',
            item: {
              type: 'message',
              content: [{ type: 'output_text', text: 'Partial' }],
            },
          }),
        ]),
      ),
    ).rejects.toThrow('codex responses stream closed before completed');
  });

  it('returns an empty string when completed arrives without output_text', async () => {
    await expect(
      collectCodexResponsesText(streamFromChunks([sseLine({ type: 'response.completed' })])),
    ).resolves.toBe('');
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
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fake-access');
    expect(headers['User-Agent']).toBe('CodexBar');
    expect(headers.Session_id).toBeUndefined();
    expect(headers['Chatgpt-Account-Id']).toBe('acct_fake');
    expect(quota.plan).toBe('plus');
    expect(quota.windows[0]).toMatchObject({ label: '5h', usedPercent: 10 });
  });
});

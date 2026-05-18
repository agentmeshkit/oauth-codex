import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const OAUTH_TOKEN_URL_FOR_CODE_EXCHANGE = OAUTH_TOKEN_URL;
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const FALLBACK_CODEX_CLI_VERSION = '0.130.0';
export const DEFAULT_CODEX_CLI_USER_AGENT =
  `codex_cli_rs/${FALLBACK_CODEX_CLI_VERSION} (Mac OS 26.3.1; arm64) iTerm.app/3.6.9`;
export const DEFAULT_CODEX_ORIGINATOR = 'codex_cli_rs';
export const CHATGPT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
export const DEFAULT_CODEX_ACCOUNT_LABEL = 'default';

const CODEX_CLI_USER_AGENT_SUFFIX = ' (Mac OS 26.3.1; arm64) iTerm.app/3.6.9';

const JWT_CLAIM_PATH = 'https://api.openai.com/auth';
const DEFAULT_REFRESH_WINDOW_MS = 60_000;
const TOKEN_FIELD_NAMES = new Set([
  'access',
  'accessToken',
  'access_token',
  'refresh',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'token',
  'authorization',
]);

export type FetchLike = typeof fetch;

export type CodexAuthShape = 'nested-chatgpt' | 'flat-imported';

export interface CodexCredentials {
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  idToken?: string;
  email?: string;
  plan?: string;
  expiresAt?: number;
  authPath: string;
  shape: CodexAuthShape;
}

export type CodexAuthWriteInput = {
  accessToken: string;
  refreshToken: string;
  accountId?: string;
  idToken?: string;
  email?: string;
  plan?: string;
  expiresAt?: number;
};

export type RefreshAccessTokenResult = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
};

export type CodexAuthManager = {
  getAccessToken(): Promise<string>;
  refresh(): Promise<string>;
  getCredentials(): CodexCredentials;
  getAccountId(): string | undefined;
  getEmail(): string | undefined;
  getPlan(): string | undefined;
};

export interface BuildCodexBackendHeadersInput {
  accessToken: string;
  accountId?: string;
  userAgent?: string;
  originator?: string;
  sessionId?: string;
  accept?: 'application/json' | 'text/event-stream';
  extra?: Record<string, string>;
}

export interface FetchWithCodexAuthOptions {
  auth: CodexAuthManager;
  url: string;
  init?: RequestInit;
  retryOnUnauthorized?: boolean;
  userAgent?: string;
  originator?: string;
  sessionId?: string;
  accept?: 'application/json' | 'text/event-stream';
  extraHeaders?: Record<string, string>;
  fetchImpl?: FetchLike;
}

export interface CodexSSEEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface ResolveDefaultCodexCliUserAgentOptions {
  env?: NodeJS.ProcessEnv;
  codexCommand?: string;
  fallbackUserAgent?: string;
}

type RawAuthFile = Record<string, unknown> & {
  auth_mode?: unknown;
  type?: unknown;
  label?: unknown;
  disabled?: unknown;
  email?: unknown;
  plan?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  account_id?: unknown;
  expires_at?: unknown;
  tokens?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

let cachedDefaultCodexCliUserAgent: string | undefined;

export function parseCodexCliVersion(output: string): string | undefined {
  return output.match(/\b(?:codex-cli|codex)\s+([0-9]+(?:\.[0-9]+){1,2}(?:[-+][^\s]+)?)/i)?.[1];
}

export function buildCodexCliUserAgent(version: string): string {
  return `codex_cli_rs/${version}${CODEX_CLI_USER_AGENT_SUFFIX}`;
}

export function detectCodexCliVersion(
  opts: Pick<ResolveDefaultCodexCliUserAgentOptions, 'env' | 'codexCommand'> = {},
): string | undefined {
  const env = opts.env ?? process.env;
  const envVersion = stringValue(env.CODEX_CLI_VERSION);
  if (envVersion) return envVersion;

  try {
    const output = execFileSync(opts.codexCommand ?? 'codex', ['--version'], {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    });
    return parseCodexCliVersion(output);
  } catch {
    return undefined;
  }
}

export function resolveDefaultCodexCliUserAgent(
  opts: ResolveDefaultCodexCliUserAgentOptions = {},
): string {
  const shouldUseCache = !opts.env && !opts.codexCommand && !opts.fallbackUserAgent;
  if (shouldUseCache && cachedDefaultCodexCliUserAgent) return cachedDefaultCodexCliUserAgent;

  const env = opts.env ?? process.env;
  const envUserAgent = stringValue(env.CODEX_CLI_USER_AGENT);
  const detectedVersion = envUserAgent
    ? undefined
    : detectCodexCliVersion({ env, codexCommand: opts.codexCommand });
  const userAgent =
    envUserAgent ??
    (detectedVersion
      ? buildCodexCliUserAgent(detectedVersion)
      : (opts.fallbackUserAgent ?? DEFAULT_CODEX_CLI_USER_AGENT));

  if (shouldUseCache && !envUserAgent) cachedDefaultCodexCliUserAgent = userAgent;
  return userAgent;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (existing && existing !== name) delete headers[existing];
  headers[name] = value;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((candidate) => candidate.toLowerCase() === name.toLowerCase());
}

function headersInitToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      setHeader(out, key, value);
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      setHeader(out, key, value);
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    setHeader(out, key, value);
  }
  return out;
}

export function buildCodexBackendHeaders(input: BuildCodexBackendHeadersInput): Record<string, string> {
  const headers: Record<string, string> = {};
  setHeader(headers, 'Authorization', `Bearer ${input.accessToken}`);
  setHeader(headers, 'Content-Type', 'application/json');
  setHeader(headers, 'User-Agent', input.userAgent ?? resolveDefaultCodexCliUserAgent());
  setHeader(headers, 'Originator', input.originator ?? DEFAULT_CODEX_ORIGINATOR);
  setHeader(headers, 'Accept', input.accept ?? 'application/json');
  if (input.accountId) setHeader(headers, 'Chatgpt-Account-Id', input.accountId);

  for (const [key, value] of Object.entries(input.extra ?? {})) {
    setHeader(headers, key, value);
  }

  if (input.sessionId && !hasHeader(headers, 'Session_id')) {
    setHeader(headers, 'Session_id', input.sessionId);
  } else if (!hasHeader(headers, 'Session_id') && getHeader(headers, 'User-Agent')?.includes('Mac OS')) {
    setHeader(headers, 'Session_id', crypto.randomUUID());
  }

  return headers;
}

export async function fetchWithCodexAuth(opts: FetchWithCodexAuthOptions): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch implementation is required for Codex backend requests');

  const doFetch = async (accessToken: string): Promise<Response> => {
    const initHeaders = headersInitToRecord(opts.init?.headers);
    const backendHeaders = buildCodexBackendHeaders({
      accessToken,
      accountId: opts.auth.getAccountId(),
      userAgent: opts.userAgent,
      originator: opts.originator,
      sessionId: opts.sessionId,
      accept: opts.accept,
      extra: opts.extraHeaders,
    });
    const headers = { ...initHeaders };
    for (const [key, value] of Object.entries(backendHeaders)) {
      setHeader(headers, key, value);
    }

    const { headers: _headers, ...initWithoutHeaders } = opts.init ?? {};
    return fetchImpl(opts.url, {
      ...initWithoutHeaders,
      headers,
    });
  };

  const first = await doFetch(await opts.auth.getAccessToken());
  if (first.status !== 401 || opts.retryOnUnauthorized === false) return first;

  const refreshedToken = await opts.auth.refresh();
  return doFetch(refreshedToken);
}

export async function* parseCodexResponsesStream(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<CodexSSEEvent> {
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';

  async function* consumeLine(rawLine: string): AsyncIterable<CodexSSEEvent> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return;

    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch (err) {
      console.warn(`skipping malformed Codex SSE data line: ${errorMessage(err)}`);
      return;
    }
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return;

    const { type, ...data } = parsed;
    yield { type, data };
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';

      for (const line of lines) {
        for await (const event of consumeLine(line)) {
          yield event;
          if (event.type === 'response.completed') return;
        }
      }
    }

    buffered += decoder.decode();
    if (buffered) {
      for await (const event of consumeLine(buffered)) {
        yield event;
        if (event.type === 'response.completed') return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function collectCodexResponsesText(
  body: ReadableStream<Uint8Array> | null,
): Promise<string> {
  const parts: string[] = [];
  let completed = false;

  for await (const event of parseCodexResponsesStream(body)) {
    if (event.type === 'response.output_item.done') {
      const item = isRecord(event.data.item) ? event.data.item : undefined;
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (!isRecord(content) || content.type !== 'output_text') continue;
        const text = stringValue(content.text);
        if (text !== undefined) parts.push(text);
      }
      continue;
    }

    if (event.type === 'response.completed') {
      completed = true;
      break;
    }
  }

  if (!completed) throw new Error('codex responses stream closed before completed');
  return parts.join('');
}

export function getCodexAuthFilePath(codexHome: string): string {
  return path.join(codexHome, 'auth.json');
}

export function getCodexAccountHome(accountsRoot: string, label = DEFAULT_CODEX_ACCOUNT_LABEL): string {
  if (!label || label === '.' || label === '..' || label.includes('/') || label.includes('\\')) {
    throw new Error(`invalid Codex account label: ${label || '<empty>'}`);
  }
  return path.join(accountsRoot, label);
}

export function getDefaultCodexAccountHome(accountsRoot: string): string {
  return getCodexAccountHome(accountsRoot, DEFAULT_CODEX_ACCOUNT_LABEL);
}

export function getDefaultCodexAuthFilePath(accountsRoot: string): string {
  return getCodexAuthFilePath(getDefaultCodexAccountHome(accountsRoot));
}

export function resolveCodexAccountsRoot(opts: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fallbackRelativePath?: string;
} = {}): string {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const configured = env.CODEX_ACCOUNTS_DIR;
  if (configured && configured.trim()) return path.resolve(configured);
  return path.resolve(cwd, opts.fallbackRelativePath ?? 'codex-runtime/accounts');
}

export function readCodexAuthFile(codexHome: string): CodexCredentials | null {
  const authPath = getCodexAuthFilePath(codexHome);
  let rawText: string;
  try {
    rawText = fs.readFileSync(authPath, 'utf8');
  } catch {
    return null;
  }

  let raw: RawAuthFile;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!isRecord(parsed)) return null;
    raw = parsed as RawAuthFile;
  } catch {
    return null;
  }

  return parseCodexAuthFile(raw, authPath);
}

export function parseCodexAuthFile(raw: RawAuthFile, authPath = 'auth.json'): CodexCredentials | null {
  const hasNestedCodexShape = raw.auth_mode === 'chatgpt' && isRecord(raw.tokens);
  const hasFlatImportedShape =
    raw.type === 'codex' || (!!stringValue(raw.access_token) && !!stringValue(raw.refresh_token));
  if (!hasNestedCodexShape && !hasFlatImportedShape) return null;

  const tokenSource = hasNestedCodexShape ? raw.tokens! : raw;
  const accessToken = stringValue(tokenSource.access_token);
  const refreshToken = stringValue(tokenSource.refresh_token);
  if (!accessToken || !refreshToken) return null;

  const idToken = stringValue(tokenSource.id_token);
  const metadata = decodeCodexTokenMetadata({ accessToken, idToken });
  const accountId = stringValue(tokenSource.account_id) ?? metadata.accountId;
  const email = stringValue(raw.email) ?? metadata.email;
  const plan = stringValue(raw.plan) ?? metadata.plan;
  const expiresAt = numberValue(tokenSource.expires_at) ?? getJwtExpiresAt(accessToken);

  return {
    accessToken,
    refreshToken,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    authPath,
    shape: hasNestedCodexShape ? 'nested-chatgpt' : 'flat-imported',
  };
}

export function writeCodexAuthFile(codexHome: string, tokens: CodexAuthWriteInput): void {
  const authPath = getCodexAuthFilePath(codexHome);
  const existing = readJsonObject(authPath) as RawAuthFile | null;
  const existingTokens = isRecord(existing?.tokens) ? existing.tokens : {};
  const metadata = decodeCodexTokenMetadata({
    accessToken: tokens.accessToken,
    idToken: tokens.idToken,
  });
  const accountId = tokens.accountId ?? metadata.accountId;
  const email = tokens.email ?? metadata.email ?? stringValue(existing?.email);
  const plan = tokens.plan ?? metadata.plan ?? stringValue(existing?.plan);

  const nextTokens: Record<string, unknown> = {
    ...existingTokens,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
  };
  if (tokens.idToken) nextTokens.id_token = tokens.idToken;
  if (accountId) nextTokens.account_id = accountId;
  if (tokens.expiresAt) nextTokens.expires_at = tokens.expiresAt;

  const next: RawAuthFile = {
    ...(existing ?? {}),
    auth_mode: 'chatgpt',
    tokens: nextTokens,
    last_refresh: new Date().toISOString(),
  };
  delete next.access_token;
  delete next.refresh_token;
  delete next.id_token;
  delete next.account_id;
  delete next.expires_at;
  if (email) next.email = email;
  if (plan) next.plan = plan;

  writeJsonFileAtomicSync(authPath, next, 0o600);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonFileAtomicSync(filePath: string, data: unknown, mode: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  );
  const text = `${JSON.stringify(data, null, 2)}\n`;

  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode });
    fs.chmodSync(tmp, mode);
    fsyncFile(tmp);
    fs.renameSync(tmp, filePath);
    fs.chmodSync(filePath, mode);
    fsyncDir(dir);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw new Error(sanitizeErrorMessage(errorMessage(err)));
  }
}

function fsyncFile(filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dirPath: string): void {
  try {
    const fd = fs.openSync(dirPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* Some filesystems do not support directory fsync. */
  }
}

export async function refreshAccessToken(
  refreshToken: string,
  opts: { fetch?: FetchLike; now?: () => number } = {},
): Promise<RefreshAccessTokenResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch implementation is required for Codex OAuth refresh');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  let resp: Response;
  try {
    resp = await fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch (err) {
    throw new Error(`codex oauth refresh failed: ${sanitizeErrorMessage(errorMessage(err), [refreshToken])}`);
  }

  if (!resp.ok) {
    const text = sanitizeErrorMessage(await safeResponseText(resp), [refreshToken]);
    const suffix = text ? ` ${text}` : ` ${resp.statusText}`;
    throw new Error(`codex oauth refresh failed: ${resp.status}${suffix}`);
  }

  let json: Record<string, unknown>;
  try {
    const parsed = (await resp.json()) as unknown;
    json = isRecord(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`codex oauth refresh failed: ${sanitizeErrorMessage(errorMessage(err), [refreshToken])}`);
  }

  const accessToken = stringValue(json.access_token);
  const nextRefreshToken = stringValue(json.refresh_token);
  const expiresIn = numberValue(json.expires_in);
  if (!accessToken || !nextRefreshToken || !expiresIn) {
    throw new Error('codex oauth refresh failed: response missing required fields');
  }

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    expiresAt: (opts.now ?? Date.now)() + expiresIn * 1000,
    ...(stringValue(json.id_token) ? { idToken: stringValue(json.id_token) } : {}),
  };
}

export function createCodexAuthManager(opts: {
  codexHome: string;
  fetch?: FetchLike;
  now?: () => number;
  refreshWindowMs?: number;
}): CodexAuthManager {
  let credentials = readCodexAuthFile(opts.codexHome);
  if (!credentials) {
    throw new Error(`no Codex ChatGPT credentials found at ${getCodexAuthFilePath(opts.codexHome)}`);
  }

  const now = opts.now ?? Date.now;
  const refreshWindowMs = opts.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS;
  let inflight: Promise<string> | null = null;

  async function refreshOnce(): Promise<string> {
    const fresh = await refreshAccessToken(credentials!.refreshToken, {
      fetch: opts.fetch,
      now,
    });
    const metadata = decodeCodexTokenMetadata({
      accessToken: fresh.accessToken,
      idToken: fresh.idToken ?? credentials!.idToken,
    });
    const next: CodexAuthWriteInput = {
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken,
      expiresAt: fresh.expiresAt,
      ...(fresh.idToken ?? credentials!.idToken ? { idToken: fresh.idToken ?? credentials!.idToken } : {}),
      ...(credentials!.accountId ?? metadata.accountId
        ? { accountId: credentials!.accountId ?? metadata.accountId }
        : {}),
      ...(credentials!.email ?? metadata.email ? { email: credentials!.email ?? metadata.email } : {}),
      ...(credentials!.plan ?? metadata.plan ? { plan: credentials!.plan ?? metadata.plan } : {}),
    };
    writeCodexAuthFile(opts.codexHome, next);
    credentials = readCodexAuthFile(opts.codexHome);
    if (!credentials) throw new Error('codex oauth refresh failed: refreshed credentials did not reload');
    return fresh.accessToken;
  }

  return {
    async getAccessToken() {
      const expAt = credentials?.expiresAt ?? getJwtExpiresAt(credentials?.accessToken ?? '');
      if (!expAt || expAt - now() > refreshWindowMs) return credentials!.accessToken;
      if (!inflight) {
        inflight = refreshOnce()
          .catch((err) => {
            throw new Error(
              sanitizeErrorMessage(errorMessage(err), [
                credentials?.accessToken,
                credentials?.refreshToken,
                credentials?.idToken,
              ]),
            );
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
    refresh() {
      if (!inflight) {
        inflight = refreshOnce().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    getCredentials() {
      return { ...credentials! };
    },
    getAccountId() {
      return credentials?.accountId ?? decodeAccountIdFromAccessToken(credentials?.accessToken ?? '');
    },
    getEmail() {
      return credentials?.email ?? decodeEmailFromToken(credentials?.idToken ?? credentials?.accessToken);
    },
    getPlan() {
      return credentials?.plan ?? decodePlanFromToken(credentials?.idToken ?? credentials?.accessToken);
    },
  };
}

export function decodeJwtPayload(token: string | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getJwtExpiresAt(token: string | undefined): number | undefined {
  const exp = numberValue(decodeJwtPayload(token)?.exp);
  return exp ? exp * 1000 : undefined;
}

export function decodeAccountIdFromAccessToken(token: string | undefined): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const claim = isRecord(payload[JWT_CLAIM_PATH]) ? payload[JWT_CLAIM_PATH] : undefined;
  return (
    stringValue(claim?.chatgpt_account_id) ??
    stringValue(payload.chatgpt_account_id) ??
    stringValue(payload.account_id)
  );
}

export function decodeEmailFromToken(token: string | undefined): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const claim = isRecord(payload[JWT_CLAIM_PATH]) ? payload[JWT_CLAIM_PATH] : undefined;
  return stringValue(payload.email) ?? stringValue(claim?.user_email);
}

export function decodePlanFromToken(token: string | undefined): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const claim = isRecord(payload[JWT_CLAIM_PATH]) ? payload[JWT_CLAIM_PATH] : undefined;
  return stringValue(claim?.chatgpt_plan_type) ?? stringValue(payload.plan);
}

export function decodeCodexTokenMetadata(tokens: {
  accessToken?: string;
  idToken?: string;
}): { accountId?: string; email?: string; plan?: string } {
  const accountId = decodeAccountIdFromAccessToken(tokens.accessToken);
  const email = decodeEmailFromToken(tokens.idToken) ?? decodeEmailFromToken(tokens.accessToken);
  const plan = decodePlanFromToken(tokens.idToken) ?? decodePlanFromToken(tokens.accessToken);
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

export function redactToken(value: string | undefined): string {
  if (!value) return '<redacted>';
  return `<redacted:${value.length}>`;
}

export function redactAuthJson<T>(value: T): T {
  return redactValue(value, undefined) as T;
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (typeof value === 'string') {
    if (key && TOKEN_FIELD_NAMES.has(key)) return redactToken(value);
    return redactTokenPatterns(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = redactValue(childValue, childKey);
  }
  return out;
}

export function sanitizeErrorMessage(message: string, secrets: Array<string | undefined> = []): string {
  let sanitized = redactTokenPatterns(message);
  for (const secret of secrets) {
    if (!secret) continue;
    sanitized = sanitized.split(secret).join(redactToken(secret));
  }
  return sanitized;
}

function redactTokenPatterns(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi, 'Bearer <redacted>')
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      '<redacted-jwt>',
    )
    .replace(
      /"(access|refresh|access_token|refresh_token|id_token|accessToken|refreshToken|idToken|token|authorization)"\s*:\s*"[^"]*"/gi,
      '"$1":"<redacted>"',
    )
    .replace(
      /\b(access|refresh|access_token|refresh_token|id_token|accessToken|refreshToken|idToken|token|authorization)=([^&\s]+)/gi,
      '$1=<redacted>',
    );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeResponseText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export type QuotaWindow = {
  label: string;
  usedPercent: number;
  resetAt: number;
  resetInSeconds: number;
  limitWindowSeconds: number;
};

export type QuotaSnapshot = {
  fetchedAt: string;
  plan: string | null;
  allowed: boolean;
  limitReached: boolean;
  reachedReason: string | null;
  windows: QuotaWindow[];
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: number | null;
    approxLocalMessages: number | null;
    approxCloudMessages: number | null;
    overageLimitReached: boolean;
  } | null;
};

type RawUsageWindow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
};

type RawUsage = {
  plan_type?: string;
  rate_limit?: {
    allowed?: boolean;
    limit_reached?: boolean;
    primary_window?: RawUsageWindow;
    secondary_window?: RawUsageWindow;
  };
  rate_limit_reached_type?: { type?: string } | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: number | string | null;
    approx_local_messages?: number | null;
    approx_cloud_messages?: number | null;
    overage_limit_reached?: boolean;
  };
};

export async function fetchCodexQuotaSnapshot(opts: {
  accessToken?: string;
  accountId?: string;
  auth?: Pick<CodexAuthManager, 'getAccessToken' | 'getAccountId'>;
  fetch?: FetchLike;
  now?: () => number;
}): Promise<QuotaSnapshot> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (!fetchImpl) throw new Error('fetch implementation is required for Codex quota requests');
  const accessToken = opts.accessToken ?? (await opts.auth?.getAccessToken());
  if (!accessToken) throw new Error('access token is required for Codex quota requests');
  const accountId = opts.accountId ?? opts.auth?.getAccountId();

  const headers = buildCodexBackendHeaders({
    accessToken,
    accountId,
    userAgent: 'CodexBar',
    accept: 'application/json',
  });

  const resp = await fetchImpl(CHATGPT_USAGE_URL, { method: 'GET', headers });
  if (!resp.ok) {
    const text = sanitizeErrorMessage(await safeResponseText(resp), [accessToken]);
    throw new Error(`codex quota request failed: ${resp.status}${text ? ` ${text}` : ''}`);
  }
  const raw = (await resp.json()) as RawUsage;
  return {
    fetchedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    ...normalizeQuota(raw),
  };
}

function normalizeQuota(raw: RawUsage): Omit<QuotaSnapshot, 'fetchedAt'> {
  const rateLimit = raw.rate_limit ?? {};
  const primaryResetAt = rateLimit.primary_window?.reset_at;
  const secondaryResetAt = rateLimit.secondary_window?.reset_at;
  const windows: QuotaWindow[] = [];

  for (const [window, slot] of [
    [rateLimit.primary_window, 'primary'],
    [rateLimit.secondary_window, 'secondary'],
  ] as const) {
    if (!window) continue;
    const limitWindowSeconds = window.limit_window_seconds ?? 0;
    windows.push({
      label:
        slot === 'primary'
          ? labelForQuotaWindow(limitWindowSeconds)
          : labelForQuotaWindow(limitWindowSeconds, primaryResetAt, secondaryResetAt),
      usedPercent: Math.max(0, Math.min(100, window.used_percent ?? 0)),
      resetAt: window.reset_at ? window.reset_at * 1000 : 0,
      resetInSeconds: window.reset_after_seconds ?? 0,
      limitWindowSeconds,
    });
  }

  const credits = raw.credits;
  const balance =
    typeof credits?.balance === 'number'
      ? credits.balance
      : typeof credits?.balance === 'string'
        ? Number.parseFloat(credits.balance)
        : null;
  const hasCreditsBlock =
    !!credits &&
    (credits.has_credits === true ||
      credits.unlimited === true ||
      credits.balance !== undefined ||
      credits.approx_local_messages !== undefined ||
      credits.approx_cloud_messages !== undefined);

  return {
    plan: raw.plan_type ?? null,
    allowed: rateLimit.allowed !== false,
    limitReached: rateLimit.limit_reached === true,
    reachedReason: raw.rate_limit_reached_type?.type ?? null,
    windows,
    credits: hasCreditsBlock
      ? {
          hasCredits: credits?.has_credits === true,
          unlimited: credits?.unlimited === true,
          balance: Number.isFinite(balance) ? balance : null,
          approxLocalMessages: credits?.approx_local_messages ?? null,
          approxCloudMessages: credits?.approx_cloud_messages ?? null,
          overageLimitReached: credits?.overage_limit_reached === true,
        }
      : null,
  };
}

function labelForQuotaWindow(seconds: number | undefined, primaryResetAt?: number, secondaryResetAt?: number): string {
  if (!seconds) return '?';
  const hours = seconds / 3600;
  if (hours >= 168) return 'Week';
  if (hours >= 24) {
    const weekGapSeconds = 3 * 24 * 3600;
    if (
      typeof primaryResetAt === 'number' &&
      typeof secondaryResetAt === 'number' &&
      secondaryResetAt - primaryResetAt >= weekGapSeconds
    ) {
      return 'Week';
    }
    return 'Day';
  }
  return `${Math.round(hours)}h`;
}

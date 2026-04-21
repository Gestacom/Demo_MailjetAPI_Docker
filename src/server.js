import http from 'node:http';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_ROOT = process.cwd();
const PORT = Number(envString('PORT', '3000'));
const STORAGE_DIR = envString('APP_STORAGE_DIR', path.join(APP_ROOT, 'storage'));
const ACCOUNTS_DIR = path.join(STORAGE_DIR, 'accounts');
const LOCKS_DIR = path.join(STORAGE_DIR, 'locks');
const LOGS_DIR = envString('APP_LOGS_DIR', path.join(APP_ROOT, 'logs'));
const LOG_FILE = path.join(LOGS_DIR, 'mailjet-service.log');
const JSON_LIMIT_BYTES = Number(envString('JSON_LIMIT_BYTES', String(2 * 1024 * 1024)));

const userLocks = new Map();

class BadRequestError extends Error {}
class ServiceError extends Error {}

await bootstrap();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(async (error) => {
    const requestId = req.requestId ?? createRequestId();

    await logEvent('error', 'uncaught_exception', {
      request_id: requestId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    sendJson(res, 500, {
      ok: false,
      request_id: requestId,
      error: 'internal_server_error',
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'server_started',
    port: PORT,
  }));
});

async function handleRequest(req, res) {
  const requestId = createRequestId();
  const startedAt = performance.now();
  req.requestId = requestId;

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        service: 'mailjet-api',
        node_version: process.version,
      });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, errorPayload(requestId, 'method_not_allowed'));
      return;
    }

    authenticateApp(req);

    const payload = await readJsonBody(req);
    const action = String(payload.action ?? '');
    const userId = sanitizeUserId(String(payload.user_id ?? ''));

    if (action === '') {
      throw new BadRequestError('missing_action');
    }

    if (userId === '') {
      throw new BadRequestError('missing_user_id');
    }

    const data = await dispatchAction(action, userId, payload, requestId);

    await logEvent('info', 'request_success', {
      request_id: requestId,
      action,
      user_id: userId,
      duration_ms: elapsedMs(startedAt),
    }, req);

    sendJson(res, 200, {
      ok: true,
      request_id: requestId,
      data,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      await logEvent('warning', 'invalid_json', {
        request_id: requestId,
        message: error.message,
        duration_ms: elapsedMs(startedAt),
      }, req);

      sendJson(res, 400, errorPayload(requestId, 'invalid_json'));
      return;
    }

    if (error instanceof BadRequestError) {
      await logEvent('warning', 'bad_request', {
        request_id: requestId,
        message: error.message,
        duration_ms: elapsedMs(startedAt),
      }, req);

      sendJson(res, 400, errorPayload(requestId, error.message));
      return;
    }

    if (error instanceof ServiceError) {
      await logEvent('error', 'runtime_error', {
        request_id: requestId,
        message: error.message,
        duration_ms: elapsedMs(startedAt),
      }, req);

      sendJson(res, 503, errorPayload(requestId, 'service_unavailable', error.message));
      return;
    }

    throw error;
  }
}

async function bootstrap() {
  await mkdir(ACCOUNTS_DIR, { recursive: true });
  await mkdir(LOCKS_DIR, { recursive: true });
  await mkdir(LOGS_DIR, { recursive: true });

  if (configValue('APP_TOKEN') === '') {
    throw new ServiceError('missing_APP_TOKEN');
  }

  if (configValue('APP_MASTER_KEY').length < 32) {
    throw new ServiceError('APP_MASTER_KEY_too_short');
  }
}

async function dispatchAction(action, userId, payload, requestId) {
  switch (action) {
    case 'connect':
      return handleConnect(payload, requestId);
    case 'disconnect':
      return handleDisconnect(userId, requestId);
    case 'get_lists':
      return handleGetLists(userId, requestId);
    case 'create_list':
      return handleCreateList(userId, payload, requestId);
    case 'import_contacts':
      return handleImportContacts(userId, payload, requestId);
    case 'legacy_manage_many_contacts':
      return handleLegacyManageManyContacts(userId, payload, requestId);
    default:
      throw new BadRequestError('unknown_action');
  }
}

async function handleConnect(payload, requestId) {
  const userId = sanitizeUserId(String(payload.user_id ?? ''));
  const apiKey = String(payload.api_key ?? '').trim();
  const apiSecret = String(payload.api_secret ?? '').trim();

  if (apiKey === '' || apiSecret === '') {
    throw new BadRequestError('missing_mailjet_credentials');
  }

  const mailjet = buildMailjetClient(apiKey, apiSecret);

  const testData = await mailjetCall({
    action: 'connect_test',
    requestId,
    userId,
    fn: () => mailjetRequest(mailjet, 'GET', 'contactslist'),
  });

  await saveAccount(userId, { api_key: apiKey, api_secret: apiSecret });

  return {
    message: 'mailjet_connected',
    lists_preview_count: extractCount(testData),
  };
}

async function handleDisconnect(userId, requestId) {
  await rm(accountFile(userId), { force: true });

  await logEvent('info', 'account_disconnected', {
    request_id: requestId,
    user_id: userId,
  });

  return { message: 'mailjet_disconnected' };
}

async function handleGetLists(userId, requestId) {
  const account = await loadAccount(userId);
  const mailjet = buildMailjetClient(account.api_key, account.api_secret);

  return mailjetCall({
    action: 'get_lists',
    requestId,
    userId,
    fn: () => mailjetRequest(mailjet, 'GET', 'contactslist'),
  });
}

async function handleCreateList(userId, payload, requestId) {
  const listName = String(payload.list_name ?? '').trim();

  if (listName === '') {
    throw new BadRequestError('missing_list_name');
  }

  const account = await loadAccount(userId);
  const mailjet = buildMailjetClient(account.api_key, account.api_secret);

  return mailjetCall({
    action: 'create_list',
    requestId,
    userId,
    fn: () => mailjetRequest(mailjet, 'POST', 'contactslist', { Name: listName }),
    context: { list_name: listName },
  });
}

async function handleImportContacts(userId, payload, requestId) {
  await rateLimit(userId, 20, 60);

  const contacts = payload.contacts;
  let listId = payload.list_id === undefined || payload.list_id === null ? null : Number(payload.list_id);
  const listName = String(payload.list_name ?? '').trim();
  const deduplicate = payload.deduplicate ?? true;

  if (!Array.isArray(contacts) || contacts.length === 0) {
    throw new BadRequestError('missing_contacts');
  }

  const normalizedContacts = normalizeContacts(contacts, Boolean(deduplicate));

  if (normalizedContacts.length === 0) {
    throw new BadRequestError('no_valid_contacts');
  }

  if ((listId === null || listId <= 0) && listName === '') {
    throw new BadRequestError('missing_list_target');
  }

  return withUserLock(userId, async () => {
    const account = await loadAccount(userId);
    const mailjet = buildMailjetClient(account.api_key, account.api_secret);

    if (listId === null || listId <= 0) {
      const createdList = await mailjetCall({
        action: 'create_list_for_import',
        requestId,
        userId,
        fn: () => mailjetRequest(mailjet, 'POST', 'contactslist', { Name: listName }),
        context: { list_name: listName },
      });

      listId = extractCreatedListId(createdList);

      if (listId <= 0) {
        throw new ServiceError('unable_to_extract_list_id');
      }
    }

    const body = {
      ContactsLists: [
        {
          ListID: listId,
          Action: 'addforce',
        },
      ],
      Contacts: normalizedContacts,
    };

    const result = await mailjetCall({
      action: 'import_contacts',
      requestId,
      userId,
      fn: () => mailjetRequest(mailjet, 'POST', 'contact/managemanycontacts', body),
      context: {
        list_id: listId,
        contacts_count: normalizedContacts.length,
      },
    });

    return {
      list_id: listId,
      contacts_count: normalizedContacts.length,
      mailjet_response: result,
    };
  });
}

async function handleLegacyManageManyContacts(userId, payload, requestId) {
  await rateLimit(userId, 20, 60);

  const body = payload.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestError('missing_body');
  }

  return withUserLock(userId, async () => {
    const account = await loadAccount(userId);
    const mailjet = buildMailjetClient(account.api_key, account.api_secret);

    return mailjetCall({
      action: 'legacy_manage_many_contacts',
      requestId,
      userId,
      fn: () => mailjetRequest(mailjet, 'POST', 'contact/managemanycontacts', body),
      context: {
        contacts_count: Array.isArray(body.Contacts) ? body.Contacts.length : null,
        contacts_lists_count: Array.isArray(body.ContactsLists) ? body.ContactsLists.length : null,
      },
    });
  });
}

function buildMailjetClient(apiKey, apiSecret) {
  return {
    apiKey,
    apiSecret,
    baseUrl: configValue('MAILJET_API_BASE', 'https://api.mailjet.com/v3/REST').replace(/\/+$/, ''),
    timeoutMs: Number(configValue('MAILJET_TIMEOUT', '30')) * 1000,
  };
}

async function mailjetRequest(client, method, resource, payload = null) {
  const url = `${client.baseUrl}/${String(resource).replace(/^\/+/, '')}`;
  const headers = {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`${client.apiKey}:${client.apiSecret}`).toString('base64')}`,
    'User-Agent': 'mailjet-api-bridge-node/1.0',
  };

  const options = {
    method: method.toUpperCase(),
    headers,
    signal: AbortSignal.timeout(client.timeoutMs),
  };

  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(payload);
  }

  const startedAt = performance.now();
  const response = await fetch(url, options);
  const rawBody = await response.text();
  let data = {};

  if (rawBody !== '') {
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = { raw: rawBody };
    }
  }

  return {
    status: response.status,
    success: response.status >= 200 && response.status < 300,
    data,
    body: rawBody,
    fetch_info: {
      url,
      method: options.method,
      duration_ms: elapsedMs(startedAt),
    },
  };
}

async function mailjetCall({ action, requestId, userId, fn, context = {}, maxAttempts = 4 }) {
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    attempt++;
    const startedAt = performance.now();

    try {
      const response = await fn();
      const status = Number(response.status ?? 0);
      const success = Boolean(response.success);

      await logEvent(success ? 'info' : 'warning', 'mailjet_response', {
        request_id: requestId,
        user_id: userId,
        action,
        attempt,
        http_status: status,
        success,
        duration_ms: elapsedMs(startedAt),
        context,
        fetch_info: response.fetch_info ?? null,
        response_body: truncateForLog(response.body),
      });

      if (success) {
        return response.data && typeof response.data === 'object' ? response.data : { raw: response.data };
      }

      if (isRetryableStatus(status)) {
        lastError = `retryable_http_status_${status}`;
        await backoffSleep(attempt);
        continue;
      }

      throw new ServiceError(`mailjet_http_status_${status}`);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);

      await logEvent('error', 'mailjet_exception', {
        request_id: requestId,
        user_id: userId,
        action,
        attempt,
        duration_ms: elapsedMs(startedAt),
        context,
        message: lastError,
      });

      if (attempt < maxAttempts) {
        await backoffSleep(attempt);
        continue;
      }
    }
  }

  throw new ServiceError(lastError ?? 'mailjet_call_failed');
}

function isRetryableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

async function saveAccount(userId, credentials) {
  const payload = {
    api_key: encryptString(String(credentials.api_key)),
    api_secret: encryptString(String(credentials.api_secret)),
    updated_at: new Date().toISOString(),
  };

  await writeFile(accountFile(userId), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

async function loadAccount(userId) {
  const file = accountFile(userId);

  if (!existsSync(file)) {
    throw new BadRequestError('mailjet_account_not_connected');
  }

  const data = JSON.parse(await readFile(file, 'utf8'));

  if (!data || typeof data !== 'object' || !data.api_key || !data.api_secret) {
    throw new ServiceError('invalid_account_storage');
  }

  return {
    api_key: decryptString(String(data.api_key)),
    api_secret: decryptString(String(data.api_secret)),
  };
}

function accountFile(userId) {
  return path.join(ACCOUNTS_DIR, `${userId}.json`);
}

function encryptString(plain) {
  const key = masterKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const mac = createHmac('sha256', key).update(Buffer.concat([iv, ciphertext])).digest();

  return Buffer.concat([iv, mac, ciphertext]).toString('base64');
}

function decryptString(encoded) {
  const key = masterKey();
  const raw = Buffer.from(encoded, 'base64');

  if (raw.length < 49) {
    throw new ServiceError('decrypt_invalid_payload');
  }

  const iv = raw.subarray(0, 16);
  const mac = raw.subarray(16, 48);
  const ciphertext = raw.subarray(48);
  const expectedMac = createHmac('sha256', key).update(Buffer.concat([iv, ciphertext])).digest();

  if (!timingSafeEqual(mac, expectedMac)) {
    throw new ServiceError('decrypt_mac_mismatch');
  }

  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function masterKey() {
  return createHash('sha256').update(configValue('APP_MASTER_KEY')).digest();
}

function normalizeContacts(contacts, deduplicate = true) {
  const normalized = [];
  const seen = new Set();

  for (const contact of contacts) {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
      continue;
    }

    const email = String(contact.email ?? contact.Email ?? '').trim().toLowerCase();
    const name = String(contact.name ?? contact.Name ?? '').trim();

    if (!isValidEmail(email)) {
      continue;
    }

    if (deduplicate && seen.has(email)) {
      continue;
    }

    seen.add(email);

    const entry = { Email: email };
    if (name !== '') {
      entry.Name = name.slice(0, 255);
    }

    normalized.push(entry);
  }

  return normalized;
}

function extractCreatedListId(response) {
  if (response?.Data?.[0]?.ID !== undefined) {
    return Number(response.Data[0].ID);
  }

  if (Array.isArray(response) && response[0]?.ID !== undefined) {
    return Number(response[0].ID);
  }

  if (response?.ID !== undefined) {
    return Number(response.ID);
  }

  return 0;
}

function extractCount(response) {
  if (response?.Count !== undefined) {
    return Number(response.Count);
  }

  if (response?.total !== undefined) {
    return Number(response.total);
  }

  return null;
}

function sanitizeUserId(userId) {
  const trimmed = userId.trim();

  if (trimmed === '') {
    return '';
  }

  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(trimmed)) {
    throw new BadRequestError('invalid_user_id');
  }

  return trimmed;
}

function authenticateApp(req) {
  const expected = configValue('APP_TOKEN');
  const provided = String(req.headers['x-app-token'] ?? '');

  if (provided === '' || !constantTimeStringEquals(expected, provided)) {
    throw new BadRequestError('invalid_app_token');
  }
}

async function rateLimit(userId, limit, windowSeconds) {
  const file = path.join(LOCKS_DIR, `ratelimit_${userId}.json`);
  const now = Math.floor(Date.now() / 1000);
  let data = {
    window_start: now,
    count: 0,
  };

  if (existsSync(file)) {
    try {
      data = { ...data, ...JSON.parse(await readFile(file, 'utf8')) };
    } catch {
      data = { window_start: now, count: 0 };
    }
  }

  if ((now - Number(data.window_start)) >= windowSeconds) {
    data = {
      window_start: now,
      count: 0,
    };
  }

  data.count = Number(data.count) + 1;
  await writeFile(file, JSON.stringify(data));

  if (data.count > limit) {
    throw new ServiceError('rate_limit_exceeded');
  }
}

async function withUserLock(userId, fn) {
  const previous = userLocks.get(userId) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);

  userLocks.set(userId, queued);

  await previous;

  try {
    return await fn();
  } finally {
    release();
    if (userLocks.get(userId) === queued) {
      userLocks.delete(userId);
    }
  }
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > JSON_LIMIT_BYTES) {
      throw new BadRequestError('payload_too_large');
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw || '{}');
}

async function logEvent(level, event, data = {}, req = null) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ip: clientIp(req),
    method: req?.method ?? null,
    uri: req?.url ?? null,
    ...data,
  };

  await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function errorPayload(requestId, error, message = null) {
  const payload = {
    ok: false,
    request_id: requestId,
    error,
  };

  if (message !== null) {
    payload.message = message;
  }

  return payload;
}

function envString(key, defaultValue = '') {
  return process.env[key] && process.env[key] !== '' ? process.env[key] : defaultValue;
}

function configValue(key, defaultValue = '') {
  return envString(key, defaultValue);
}

function createRequestId() {
  return randomBytes(8).toString('hex');
}

function elapsedMs(startedAt) {
  return Math.round(performance.now() - startedAt);
}

async function backoffSleep(attempt) {
  const baseMs = [250, 800, 1800, 3500][attempt - 1] ?? 3500;
  await sleep(baseMs + randomInt(0, 301));
}

function truncateForLog(value, max = 3000) {
  const string = typeof value === 'string' ? value : JSON.stringify(value);

  if (string.length > max) {
    return `${string.slice(0, max)}...[truncated]`;
  }

  return string;
}

function clientIp(req) {
  const forwardedFor = req?.headers?.['x-forwarded-for'];

  if (typeof forwardedFor === 'string' && forwardedFor !== '') {
    return forwardedFor.split(',')[0].trim();
  }

  return req?.socket?.remoteAddress ?? null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function constantTimeStringEquals(expected, provided) {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

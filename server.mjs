import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APIError, APITimeoutError, APIConnectionError, choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
loadLocalEnv();

const MODEL = process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest';
const REQUEST_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS) || 2000;
const MAX_IN_FLIGHT_PER_CLIENT = 12;
const STREAM_HEARTBEAT_MS = 15_000;
const WARM_EVERY_MS = 20_000;
const WARM_FOR_MS = 10 * 60_000;
const WARM_AFTER_IDLE_MS = WARM_EVERY_MS / 2;
const JEV_LOG_LIMIT = 50;
const JEV_LOG_PATH = `${ROOT}jev-logs.jsonl`;
const ACTION_INSTRUCTIONS = {
  question: 'Should the bird flap now or wait?',
  guidance: 'Choose the action that best keeps the bird alive and passing the next pipe.',
};
const ACTION_CRITERIA = {
  flap: 'The bird moves upward immediately. Choose this when it improves the path through the next pipe.',
  wait: 'The bird continues under gravity. Choose this when another flap would make survival less likely.',
};

const PORT = Number(process.env.PORT || 4173);
const eventStreams = new Map();
const queuedEvents = new Map();
const inFlightByClient = new Map();
const typesafeAgent = new Agent({ allowH2: true, keepAliveTimeout: 60_000 });
const typesafeFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: typesafeAgent });
let typesafeClient = null;
let lastDecisionAt = performance.now();
let warmer;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function loadLocalEnv() {
  const envPath = `${ROOT}.env`;
  if (!existsSync(envPath)) return;

  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function readJevLogs() {
  if (!existsSync(JEV_LOG_PATH)) return [];
  return readFileSync(JEV_LOG_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .slice(-JEV_LOG_LIMIT);
}

function saveJevLog(entry) {
  const logs = [...readJevLogs(), entry].slice(-JEV_LOG_LIMIT);
  writeFileSync(JEV_LOG_PATH, `${logs.map((log) => JSON.stringify(log)).join('\n')}\n`);
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new Error('Request is too large.');
  }
  return JSON.parse(body);
}

function getTypeSafeClient() {
  const apiKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
  if (!apiKey) throw new Error('TypeSafe API key is not configured.');
  typesafeClient ??= new TypeSafeClient({
    apiKey,
    defaultModel: MODEL,
    fetch: typesafeFetch,
    timeout: REQUEST_TIMEOUT_MS,
    retry: { maxRetries: 0 },
  });
  return typesafeClient;
}

function warmTypeSafeConnection() {
  if (!(process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY)) return;
  void getTypeSafeClient().models.list({ timeout: 5000 }).catch(() => {});
}

function keepTypeSafeConnectionWarm() {
  if (warmer || !(process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY)) return;
  warmTypeSafeConnection();
  warmer = setInterval(() => {
    const idleFor = performance.now() - lastDecisionAt;
    if (idleFor > WARM_FOR_MS) {
      clearInterval(warmer);
      warmer = undefined;
    } else if (idleFor > WARM_AFTER_IDLE_MS) {
      warmTypeSafeConnection();
    }
  }, WARM_EVERY_MS);
  warmer.unref();
}

function publishEvent(clientId, event) {
  const response = eventStreams.get(clientId);
  const serialized = `data: ${JSON.stringify(event)}\n\n`;
  if (response && !response.destroyed && !response.writableEnded) {
    response.write(serialized);
    return;
  }

  const pending = queuedEvents.get(clientId) || [];
  pending.push(serialized);
  queuedEvents.set(clientId, pending.slice(-MAX_IN_FLIGHT_PER_CLIENT));
}

function openEventStream(request, response, clientId) {
  if (!clientId || clientId.length > 128) {
    sendError(response, 400, 'A valid stream client ID is required.');
    return;
  }

  const previous = eventStreams.get(clientId);
  if (previous && previous !== response && !previous.destroyed && !previous.writableEnded) previous.end();
  eventStreams.set(clientId, response);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  response.write(': connected\n\n');
  const pending = queuedEvents.get(clientId) || [];
  for (const event of pending) response.write(event);
  queuedEvents.delete(clientId);
  response.on('close', () => {
    if (eventStreams.get(clientId) === response) eventStreams.delete(clientId);
  });
}

async function handleJevAction(request, response) {
  let input;
  try {
    input = await readJson(request);
  } catch {
    sendError(response, 400, 'Expected a valid JSON request.');
    return;
  }

  const clientId = input.client;
  if (typeof clientId !== 'string' || clientId.length > 128 || !Number.isInteger(input.rid) || input.rid < 1) {
    sendError(response, 400, 'A valid client ID and request ID are required.');
    return;
  }
  if (!input.state || typeof input.state !== 'object') {
    sendError(response, 400, 'A structured game state is required.');
    return;
  }
  if (!Number.isInteger(input.trajectory_version) || input.trajectory_version < 0) {
    sendError(response, 400, 'A valid trajectory version is required.');
    return;
  }
  if (!eventStreams.has(clientId)) {
    sendError(response, 409, 'The answer stream is not connected.');
    return;
  }
  if (!(process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY)) {
    sendError(response, 503, 'TypeSafe API key is not configured.');
    return;
  }
  const inFlight = inFlightByClient.get(clientId) || 0;
  if (inFlight >= MAX_IN_FLIGHT_PER_CLIENT) {
    sendError(response, 429, 'Too many Jev decisions are already in flight.');
    return;
  }

  inFlightByClient.set(clientId, inFlight + 1);
  lastDecisionAt = performance.now();
  keepTypeSafeConnectionWarm();
  sendJson(response, 202, { accepted: true });
  void answerJevDecision(input).finally(() => {
    const remaining = (inFlightByClient.get(clientId) || 1) - 1;
    if (remaining === 0) inFlightByClient.delete(clientId);
    else inFlightByClient.set(clientId, remaining);
  });
}

async function answerJevDecision(input) {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const modelRequest = {
    state: input.state,
    model: MODEL,
    questions: {
      action: {
        type: 'choice',
        instructions: ACTION_INSTRUCTIONS,
        criteria: ACTION_CRITERIA,
      },
    },
  };

  try {
    const { data, response, requestId } = await getTypeSafeClient()
      .systemOne({
        state: input.state,
        questions: { action: choice(ACTION_INSTRUCTIONS, ACTION_CRITERIA) },
      })
      .withResponse();
    const answer = data.answers?.action;
    if (!answer || !['flap', 'wait'].includes(answer.choice)) {
      throw new Error('TypeSafe returned an invalid action.');
    }

    const result = {
      action: answer.choice,
      trajectory_version: input.trajectory_version,
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? {},
      usage: data.usage,
      model: data.model,
    };
    const trace = {
      id: traceId,
      at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt,
      ok: true,
      request: modelRequest,
      response: {
        model: data.model,
        answers: data.answers,
        usage: data.usage,
        request_id: requestId,
        jev_ms: Number(response.headers.get('x-envoy-upstream-service-time')) || null,
      },
      result,
    };
    saveJevLog(trace);
    publishEvent(input.client, { rid: input.rid, status: 200, body: { ...result, trace } });
  } catch (error) {
    const message = error instanceof APITimeoutError
      ? 'TypeSafe request timed out.'
      : error instanceof APIError || error instanceof APIConnectionError
        ? 'Could not get a decision from TypeSafe.'
        : error.message === 'TypeSafe API key is not configured.'
          ? error.message
          : 'Could not get a decision from TypeSafe.';
    console.error(message, error.message);
    const trace = {
      id: traceId,
      at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt,
      ok: false,
      request: modelRequest,
      error: message,
    };
    saveJevLog(trace);
    publishEvent(input.client, { rid: input.rid, status: 502, body: { error: message, trace } });
  }
}

function serveStatic(pathname, response) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const fileName = requestedPath.slice(1);
  if (!['index.html', 'game.js', 'ai-history.js', 'styles.css'].includes(fileName)) {
    sendError(response, 404, 'Not found.');
    return;
  }

  try {
    const content = readFileSync(`${ROOT}${fileName}`);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[fileName.slice(fileName.lastIndexOf('.'))],
      'Cache-Control': 'no-cache',
    });
    response.end(content);
  } catch {
    sendError(response, 404, 'Not found.');
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/api/jev/stream') {
    openEventStream(request, response, url.searchParams.get('client'));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/jev/action') {
    await handleJevAction(request, response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, { ok: true, typesafeConfigured: Boolean(process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY) });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/jev/logs') {
    sendJson(response, 200, { logs: readJevLogs() });
    return;
  }

  if (request.method === 'DELETE' && url.pathname === '/api/jev/logs') {
    writeFileSync(JEV_LOG_PATH, '');
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET') {
    serveStatic(url.pathname, response);
    return;
  }

  sendError(response, 405, 'Method not allowed.');
});

const heartbeat = setInterval(() => {
  for (const response of eventStreams.values()) {
    if (!response.destroyed && !response.writableEnded) response.write(': ping\n\n');
  }
}, STREAM_HEARTBEAT_MS);
heartbeat.unref();

keepTypeSafeConnectionWarm();

server.on('close', () => {
  clearInterval(heartbeat);
  if (warmer) clearInterval(warmer);
  void typesafeAgent.close();
});

server.listen(PORT, () => {
  console.log(`Flappy Bird running at http://localhost:${PORT}`);
});

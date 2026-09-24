import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APIError, APITimeoutError, APIConnectionError, choice, TypeSafeClient } from '@typesafe-ai/sdk';
import { Agent, fetch as undiciFetch } from 'undici';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
loadLocalEnv();

const MODEL = process.env.TYPESAFE_DEFAULT_MODEL || 'jev-latest';
const OPENAI_MODEL = 'gpt-6-luna';
const REQUEST_TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS) || 30_000;
const WARM_EVERY_MS = 20_000;
const WARM_FOR_MS = 10 * 60_000;
const WARM_AFTER_IDLE_MS = WARM_EVERY_MS / 2;
const JEV_LOG_LIMIT = 50;
const JEV_LOG_PATH = `${ROOT}jev-logs.jsonl`;
const ACTION_QUESTION = 'What should the bird do right now to pass safely through the gap of the next pipe?';
const ACTION_CHOICES = {
  flap: 'Flap: the bird is below the gap, or is in the lower half of the gap and not rising.',
  wait: 'Wait: the bird is above the gap (even when falling fast), or is in the upper half of the gap, or is rising inside the gap.',
};
const streams = new Map();
function openStream(response, client) {
  if (typeof client !== 'string' || !client || client.length > 128) { sendError(response, 400, 'Invalid client.'); return; }
  streams.get(client)?.end();
  streams.set(client, response);
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
  response.write(': connected\n\n');
  const heartbeat = setInterval(() => response.write(': ping\n\n'), 15000);
  response.on('close', () => { clearInterval(heartbeat); if (streams.get(client) === response) streams.delete(client); });
}
async function queueAction(request, response, controller) {
  let input;
  try { input = await readJson(request); } catch { sendError(response, 400, 'Invalid JSON.'); return; }
  if (!input || typeof input.rid !== 'string' || input.rid.length > 100 || !streams.has(input.client)) {
    sendError(response, 409, 'Connect the answer stream first.'); return;
  }
  sendJson(response, 202, { accepted: true });
  let status = 200;
  const sink = {
    writeHead(code) { status = code; },
    end(body) {
      const stream = streams.get(input.client);
      if (stream && !stream.destroyed && !stream.writableEnded) stream.write(`data: ${JSON.stringify({ rid: input.rid, status, body: JSON.parse(body) })}\n\n`);
    },
  };
  await handleAction(request, sink, controller, input);
}

const PORT = Number(process.env.PORT || 4173);
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

async function handleAction(request, response, controller, suppliedInput) {
  let input;
  try { input = suppliedInput ?? await readJson(request); }
  catch { sendError(response, 400, 'Expected a valid JSON request.'); return; }
  if (!input || !input.state || typeof input.state !== 'object' || Array.isArray(input.state)
      || !Number.isInteger(input.sequence) || input.sequence < 0
      || typeof input.client !== 'string' || !input.client || input.client.length > 128) {
    sendError(response, 400, 'A game state, client ID, and decision sequence are required.');
    return;
  }
  const clientKey = `${controller}:${input.client}`;
  const active = inFlightByClient.get(clientKey) || 0;
  if (active >= 12) {
    sendError(response, 429, 'Too many pending decisions for this game.'); return;
  }
  inFlightByClient.set(clientKey, active + 1);
  const startedAt = Date.now();
  const modelRequest = {
    model: controller === 'jev' ? MODEL : OPENAI_MODEL,
    state: input.state,
    questions: { action: { type: 'choice', instructions: ACTION_QUESTION, criteria: ACTION_CHOICES } },
  };
  try {
    let result;
    if (controller === 'jev') {
      lastDecisionAt = performance.now();
      keepTypeSafeConnectionWarm();
      const data = await getTypeSafeClient().systemOne({
        state: input.state,
        questions: { action: choice(ACTION_QUESTION, ACTION_CHOICES) },
      });
      const answer = data.answers?.action;
      result = { action: answer?.choice, confidence: answer?.confidence ?? null,
        probabilities: answer?.probabilities ?? {}, model: data.model, usage: data.usage };
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey || apiKey === 'your_openai_api_key') throw new Error('OpenAI API key is not configured.');
      const upstream = await typesafeFetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        body: JSON.stringify({
          model: OPENAI_MODEL, reasoning_effort: 'none', max_completion_tokens: 400,
          messages: [
            { role: 'system', content: JSON.stringify({ instructions: ACTION_QUESTION, criteria: ACTION_CHOICES }) },
            { role: 'user', content: JSON.stringify({ state: input.state }) },
          ],
          response_format: { type: 'json_schema', json_schema: {
            name: 'flappy_bird_action', strict: true,
            schema: { type: 'object', properties: { action: { type: 'string', enum: ['flap', 'wait'] } },
              required: ['action'], additionalProperties: false },
          } },
        }),
      });
      if (!upstream.ok) throw new Error(`OpenAI request failed (HTTP ${upstream.status}).`);
      const payload = await upstream.json();
      const answer = JSON.parse(payload.choices?.[0]?.message?.content || '{}');
      result = { action: answer.action, confidence: null, probabilities: {}, model: payload.model, usage: payload.usage };
    }
    if (!['flap', 'wait'].includes(result.action)) throw new Error('Model returned an invalid action.');
    result.sequence = input.sequence;
    const trace = { id: randomUUID(), at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt, ok: true, request: modelRequest, result };
    sendJson(response, 200, { ...result, trace });
    if (controller === 'jev') { try { saveJevLog(trace); } catch {} }
  } catch (error) {
    const message = error instanceof APITimeoutError || error.name === 'TimeoutError'
      ? 'Model request timed out.' : error instanceof APIError || error instanceof APIConnectionError
        ? `Could not get a decision from ${controller === 'jev' ? 'TypeSafe' : 'OpenAI'}.` : error.message;
    if (controller === 'jev') {
      try {
        saveJevLog({ id: randomUUID(), at: new Date(startedAt).toISOString(),
          duration_ms: Date.now() - startedAt, ok: false, request: modelRequest,
          error: { message, name: error.name, status: error.status ?? error.statusCode ?? null,
            code: error.code ?? null, cause: error.cause?.message ?? null } });
      } catch {}
    }
    sendError(response, 502, message);
  } finally {
    const remaining = (inFlightByClient.get(clientKey) || 1) - 1;
    if (remaining > 0) inFlightByClient.set(clientKey, remaining);
    else inFlightByClient.delete(clientKey);
  }
}

function serveStatic(pathname, response) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const fileName = requestedPath.slice(1);
  if (!['index.html', 'bootstrap.js', 'game.js', 'ai-history.js', 'styles.css'].includes(fileName)) {
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

  if (request.method === 'GET' && url.pathname === '/api/decisions/stream') {
    openStream(response, url.searchParams.get('client'));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/jev/action') {
    await queueAction(request, response, 'jev');
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/openai/action') {
    await queueAction(request, response, 'openai');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      typesafeConfigured: Boolean(process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY),
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY !== 'your_openai_api_key'),
    });
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

keepTypeSafeConnectionWarm();

server.on('close', () => {
  if (warmer) clearInterval(warmer);
  void typesafeAgent.close();
});

server.listen(PORT, () => {
  console.log(`Flappy Bird running at http://localhost:${PORT}`);
});

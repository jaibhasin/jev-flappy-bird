import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const REQUEST_TIMEOUT_MS = 4000;
const JEV_LOG_LIMIT = 50;
const JEV_LOG_PATH = `${ROOT}jev-logs.jsonl`;

loadLocalEnv();

const PORT = Number(process.env.PORT || 4173);

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

async function handleJevAction(request, response) {
  const apiKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
  if (!apiKey) {
    sendError(response, 503, 'TypeSafe API key is not configured.');
    return;
  }

  let input;
  try {
    input = await readJson(request);
  } catch {
    sendError(response, 400, 'Expected a valid JSON request.');
    return;
  }

  if (!input.state || typeof input.state !== 'object') {
    sendError(response, 400, 'A structured game state is required.');
    return;
  }

  const sequences = Array.isArray(input.sequences) ? input.sequences.filter((sequence) => (
    typeof sequence?.id === 'string'
    && typeof sequence.description === 'string'
    && Array.isArray(sequence.actions)
    && sequence.actions.length === 7
    && sequence.actions.every((action) => action === 'flap' || action === 'wait')
  )) : [];
  if (sequences.length === 0) {
    sendError(response, 400, 'At least one valid action sequence is required.');
    return;
  }

  const sequenceCriteria = Object.fromEntries(sequences.map((sequence) => [sequence.id, sequence.description]));
  const traceId = randomUUID();
  const startedAt = Date.now();
  const modelRequest = {
    state: input.state,
    model: MODEL,
    questions: {
      action_plan: {
        type: 'choice',
        instructions: {
          question: 'Choose the seven-step action sequence most likely to keep the bird alive and pass the next pipe.',
          guidance: 'Only collision-free sequences are offered when one exists. First prefer more pipes passed, then prefer an ending gap offset closest to zero. Each step lasts 1/7 second.',
        },
        criteria: sequenceCriteria,
      },
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(modelRequest),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      throw new Error(`TypeSafe returned HTTP ${upstream.status}.`);
    }

    const payload = await upstream.json();
    const answer = payload.answers?.action_plan;
    const selectedSequence = sequences.find((sequence) => sequence.id === answer?.choice);
    if (!answer || !selectedSequence) {
      throw new Error('TypeSafe returned an invalid action plan.');
    }

    const appResponse = {
      actions: selectedSequence.actions,
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? {},
    };
    const trace = {
      id: traceId,
      at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt,
      ok: true,
      request: modelRequest,
      response: payload,
      result: appResponse,
    };
    saveJevLog(trace);
    sendJson(response, 200, { ...appResponse, trace });
  } catch (error) {
    const message = error.name === 'AbortError' ? 'TypeSafe request timed out.' : 'Could not get a decision from TypeSafe.';
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
    sendJson(response, 502, { error: message, trace });
  } finally {
    clearTimeout(timeout);
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

server.listen(PORT, () => {
  console.log(`Flappy Bird running at http://localhost:${PORT}`);
});

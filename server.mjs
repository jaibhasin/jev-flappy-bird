import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
const REQUEST_TIMEOUT_MS = 4000;

loadLocalEnv();

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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const upstream = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: input.state,
        model: MODEL,
        questions: {
          action: {
            type: 'choice',
            instructions: 'Choose the immediate action that best keeps the bird inside the next pipe opening.',
            criteria: {
              flap: 'Apply one upward impulse now.',
              wait: 'Do not apply an impulse now.',
            },
          },
        },
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      throw new Error(`TypeSafe returned HTTP ${upstream.status}.`);
    }

    const payload = await upstream.json();
    const answer = payload.answers?.action;
    if (!answer || !['flap', 'wait'].includes(answer.choice)) {
      throw new Error('TypeSafe returned an invalid action.');
    }

    sendJson(response, 200, {
      action: answer.choice,
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? {},
    });
  } catch (error) {
    const message = error.name === 'AbortError' ? 'TypeSafe request timed out.' : 'Could not get a decision from TypeSafe.';
    console.error(message, error.message);
    sendError(response, 502, message);
  } finally {
    clearTimeout(timeout);
  }
}

function serveStatic(pathname, response) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const fileName = requestedPath.slice(1);
  if (!['index.html', 'game.js', 'styles.css'].includes(fileName)) {
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

  if (request.method === 'GET') {
    serveStatic(url.pathname, response);
    return;
  }

  sendError(response, 405, 'Method not allowed.');
});

server.listen(PORT, () => {
  console.log(`Flappy Bird running at http://localhost:${PORT}`);
});

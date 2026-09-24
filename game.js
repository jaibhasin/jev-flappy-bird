const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
const RUNNER = new URLSearchParams(location.search).get('runner');
const CONTROLLER = RUNNER === 'openai' ? 'openai' : 'jev';
const MODEL_LABEL = CONTROLLER === 'openai' ? 'GPT-6 Luna' : 'Jev';
const EMBEDDED = Boolean(RUNNER && window.parent !== window);
const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const GROUND_HEIGHT = 92;
const PLAY_BOTTOM = HEIGHT - GROUND_HEIGHT;
const PIPE_WIDTH = 76;
const PIPE_GAP = 178;
const PIPE_SPACING = 255;
const PIPE_SPEED = 178;
const BIRD_X = 122;
const BIRD_RADIUS = 16;
const COLLISION_RADIUS = 12;
const GRAVITY = 950;
const FLAP_VELOCITY = -330;
const MODEL_GAME_SPEED = 0.3;
const MODEL_REQUEST_INTERVAL_MS = 50;
const MODEL_MAX_IN_FLIGHT = 12;
const clientId = crypto.randomUUID();
const ids = ['score', 'run-status', 'start-overlay', 'overlay-kicker', 'overlay-title', 'overlay-copy',
  'start-button', 'human-mode', 'physics-mode', 'control-hint', 'live-action',
  'wait-confidence', 'wait-confidence-fill', 'flap-confidence', 'flap-confidence-fill',
  'stat-latency', 'stat-decisions', 'jev-action',
  'jev-question', 'jev-state', 'jev-choices', 'decision-history', 'decision-counts'];
const ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let gameState;
let matchId = null;
let generation = 0;
let scheduledLaunch = null;
let lastFrame = performance.now();
let accumulator = 0;
let requestTimer;
let leadEstimate = 280;
let queuedAnswers = [];
let nextSequence = 0;
let streamReady = false;
const responseWaiters = new Map();
const stream = new EventSource(`/api/decisions/stream?client=${encodeURIComponent(clientId)}`);
stream.onopen = () => {
  streamReady = true;
  if (gameState?.phase === 'starting') requestModelDecision();
};
stream.onerror = () => { streamReady = false; };
stream.onmessage = (event) => {
  try {
    const packet = JSON.parse(event.data);
    responseWaiters.get(packet.rid)?.(packet);
  } catch {}
};
function postDecision(body, signal) {
  const rid = `${generation}:${body.sequence}`;
  return new Promise((resolve, reject) => {
    const cleanup = () => { responseWaiters.delete(rid); signal.removeEventListener('abort', aborted); };
    const aborted = () => { cleanup(); reject(new Error('Request cancelled or timed out')); };
    signal.addEventListener('abort', aborted, { once: true });
    responseWaiters.set(rid, (packet) => { cleanup(); resolve(packet); });
    fetch(`/api/${CONTROLLER}/action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ ...body, rid, client: clientId }),
    }).then(async (response) => {
      if (response.status !== 202) {
        const error = await response.json().catch(() => ({}));
        cleanup(); reject(new Error(error.error || 'Decision request rejected'));
      }
    }).catch((error) => { cleanup(); reject(error); });
  });
}
const pending = new Map();
let recent = [];

function report(type, extra = {}) {
  if (EMBEDDED) window.parent.postMessage({ type, runner: RUNNER, matchId, ...extra }, location.origin);
}
function randomSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]; }
function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}
function createPipes(seed) {
  const random = seededRandom(seed);
  return Array.from({ length: 40 }, (_, index) => {
    const center = 155 + random() * 305;
    return { x: WIDTH + 95 + index * PIPE_SPACING, gapTop: center - PIPE_GAP / 2,
      gapBottom: center + PIPE_GAP / 2, scored: false };
  });
}
function resetGame(mode = 'physics', seed = randomSeed()) {
  generation += 1;
  for (const controller of pending.values()) controller.abort();
  pending.clear();
  clearInterval(requestTimer);
  queuedAnswers = [];
  accumulator = 0;
  leadEstimate = 280;
  scheduledLaunch = null;
  nextSequence = 0;
  recent = [];
  gameState = { mode, seed, phase: 'ready', score: 0, elapsed: 0, flash: 0,
    bird: { y: HEIGHT * 0.45, velocity: 0, rotation: 0 }, pipes: createPipes(seed),
    ai: { epoch: 0, appliedSequence: -1, firstAction: null, discarded: 0, skipped: 0,
      latency: null, received: 0, errors: 0, error: null,
      lastAction: null, flapsApplied: 0 } };
  ui['start-overlay'].classList.remove('hidden');
  ui['overlay-kicker'].textContent = `${MODEL_LABEL} ready`;
  ui['overlay-title'].textContent = 'BORN TO FLY.';
  ui['overlay-copy'].textContent = EMBEDDED ? 'Start the matchup above.' : 'Ready for takeoff.';
  ui['start-button'].textContent = 'Start run';
  ui['jev-action'].textContent = 'Awaiting decision';
  setConfidence(null);
  ui['jev-question'].textContent = 'Should the bird FLAP now or WAIT?';
  ui['jev-state'].textContent = 'Waiting for observation';
  ui['jev-choices'].textContent = 'One action per decision.';
  ui['decision-history'].replaceChildren();
  renderUI();
}
function modelObservation(leadMs) {
  let y = gameState.bird.y;
  let velocity = gameState.bird.velocity;
  const leadSeconds = leadMs * MODEL_GAME_SPEED / 1000;
  for (let remaining = leadSeconds; remaining > 0.000001;) {
    const step = Math.min(1 / 120, remaining);
    velocity += GRAVITY * step;
    y += velocity * step;
    remaining -= step;
  }
  const shift = PIPE_SPEED * leadSeconds;
  const pipe = gameState.pipes.find((candidate) => candidate.x - shift + PIPE_WIDTH >= BIRD_X - COLLISION_RADIUS);
  const above = pipe ? y - COLLISION_RADIUS - pipe.gapTop : y - COLLISION_RADIUS;
  const below = pipe ? pipe.gapBottom - y - COLLISION_RADIUS : PLAY_BOTTOM - y - COLLISION_RADIUS;
  const round = Math.round;
  return {
    observed_game_ms: round(gameState.elapsed * 1000), prediction_lead_ms: leadMs,
    bird_y: round(y), bird_velocity: round(velocity),
    pipe_distance: pipe ? round(pipe.x - shift - BIRD_X) : null,
    gap_top: pipe ? round(pipe.gapTop) : null, gap_bottom: pipe ? round(pipe.gapBottom) : null,
    clearance_above: round(above), clearance_below: round(below),
    position: above < 0 ? 'above the gap' : below < 0 ? 'below the gap'
      : above < below ? 'inside the gap, upper half' : 'inside the gap, lower half',
    motion: velocity < -60 ? 'rising' : velocity > 250 ? 'falling fast' : velocity > 60 ? 'falling' : 'level',
    ceiling_clearance: round(y - COLLISION_RADIUS), ground_clearance: round(PLAY_BOTTOM - y - COLLISION_RADIUS),
    y_axis: 'y grows downward; smaller y is higher',
  };
}
function addHistory(sequence, action, latency, disposition) {
  recent.unshift({ sequence, action, latency, disposition });
  recent = recent.slice(0, 5);
  ui['decision-history'].replaceChildren(...recent.map((entry) => {
    const row = document.createElement('li');
    for (const text of [`#${entry.sequence}`, entry.action.toUpperCase(), `${entry.latency}ms`, entry.disposition]) {
      const cell = document.createElement('span');
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }));
}
function setConfidence(probabilities) {
  const entries = [
    ['wait', ui['wait-confidence'], ui['wait-confidence-fill']],
    ['flap', ui['flap-confidence'], ui['flap-confidence-fill']],
  ];
  const values = entries.map(([key]) => {
    const value = probabilities?.[key];
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  });
  const total = values.every(Number.isFinite) ? values[0] + values[1] : 0;
  entries.forEach(([key, label, fill], index) => {
    const percent = total > 0 ? Math.round(values[index] / total * 100) : null;
    setText(label, percent === null ? '-' : `${percent}%`);
    const width = percent === null ? '0%' : `${percent}%`;
    if (fill.style.width !== width) fill.style.width = width;
    if (percent === null) fill.parentElement.removeAttribute('aria-valuenow');
    else fill.parentElement.setAttribute('aria-valuenow', String(percent));
  });
}
function consumeModelAnswers() {
  const due = queuedAnswers.filter((answer) => answer.target <= gameState.elapsed * 1000 + 0.001);
  queuedAnswers = queuedAnswers.filter((answer) => answer.target > gameState.elapsed * 1000 + 0.001);
  for (const answer of due.sort((a, b) => a.sequence - b.sequence)) {
    if (gameState.phase !== 'running') return;
    const ai = gameState.ai;
    const stale = answer.epoch !== ai.epoch || answer.sequence <= ai.appliedSequence;
    if (stale) ai.discarded += 1;
    else {
      ai.lastAction = answer.action;
      ai.appliedSequence = answer.sequence;
      if (answer.action === 'flap') {
        applyFlap();
        ai.epoch += 1;
        requestModelDecision();
      }
    }
    const disposition = stale ? 'superseded' : 'applied';
    ui['jev-action'].textContent = `${answer.action.toUpperCase()} · ${disposition}`;
    addHistory(answer.sequence, answer.action, answer.latency, disposition);
  }
}
async function requestModelDecision() {
  if (!['starting', 'running'].includes(gameState.phase) || !streamReady) return;
  if (pending.size >= MODEL_MAX_IN_FLIGHT || (gameState.phase === 'starting' && pending.size)) {
    gameState.ai.skipped += 1;
    return;
  }
  const sequence = nextSequence++;
  const run = generation;
  const epoch = gameState.ai.epoch;
  const leadMs = gameState.phase === 'starting' ? 0 : Math.round(leadEstimate);
  const target = gameState.elapsed * 1000 + leadMs * MODEL_GAME_SPEED;
  const state = modelObservation(leadMs);
  const controller = new AbortController();
  pending.set(sequence, controller);
  const timeout = setTimeout(() => controller.abort(), gameState.phase === 'starting' ? 30_000 : 8000);
  const startedAt = performance.now();
  ui['jev-state'].textContent = JSON.stringify(state);
  try {
    const packet = await postDecision({ state, sequence }, controller.signal);
    if (run !== generation || !['starting', 'running'].includes(gameState.phase)) return;
    if (packet.status !== 200) throw new Error(packet.body?.error || 'Model request failed');
    const result = packet.body;
    if (!['flap', 'wait'].includes(result.action) || result.sequence !== sequence) throw new Error('Invalid model decision');
    const ai = gameState.ai;
    const latency = Math.round(performance.now() - startedAt);
    leadEstimate += (Math.min(latency, 1000) - leadEstimate) * 0.2;
    ai.latency = latency;
    ai.received += 1;
    ai.error = null;
    setConfidence(result.probabilities);
    if (gameState.phase === 'starting') {
      ai.firstAction = { action: result.action, sequence, latency };
      if (EMBEDDED) {
        gameState.phase = 'armed';
        ui['overlay-kicker'].textContent = 'First decision ready';
        ui['overlay-title'].textContent = 'READY TO FLY';
        ui['overlay-copy'].textContent = 'Both birds will take off together.';
        report('runner-armed');
      } else launchGame(performance.now());
    } else {
      queuedAnswers.push({ action: result.action, sequence, epoch, target, latency });
      consumeModelAnswers();
    }
  } catch (error) {
    if (run !== generation || !['starting', 'running'].includes(gameState.phase)) return;
    gameState.ai.errors += 1;
    gameState.ai.error = error.message;
    addHistory(sequence, 'error', Math.round(performance.now() - startedAt), 'no input');
    if (gameState.phase === 'starting') {
      gameState.phase = 'aierror';
      ui['overlay-title'].textContent = 'CONNECTION ERROR';
      ui['overlay-copy'].textContent = error.message;
      report('runner-error', { error: error.message });
    }
  } finally {
    clearTimeout(timeout);
    if (run === generation) { pending.delete(sequence); renderUI(); }
  }
}
function launchGame(now, elapsedSinceLaunch = 0) {
  if (gameState.phase !== 'starting' && gameState.phase !== 'armed') return;
  const first = gameState.ai.firstAction;
  if (!first) return;
  gameState.phase = 'running';
  gameState.ai.lastAction = first.action;
  gameState.ai.appliedSequence = first.sequence;
  if (first.action === 'flap') { applyFlap(); gameState.ai.epoch += 1; }
  ui['start-overlay'].classList.add('hidden');
  ui['jev-action'].textContent = `${first.action.toUpperCase()} · applied`;
  addHistory(first.sequence, first.action, first.latency, 'applied');
  lastFrame = now - elapsedSinceLaunch;
  requestTimer = setInterval(requestModelDecision, MODEL_REQUEST_INTERVAL_MS);
  requestModelDecision();
}
function applyFlap() {
  gameState.bird.velocity = FLAP_VELOCITY;
  gameState.bird.rotation = -0.35;
  gameState.flash = 0.1;
  gameState.ai.lastAction = 'flap';
  gameState.ai.flapsApplied += 1;
}
function startGame() {
  if (gameState.mode === 'human') {
    gameState.phase = 'running';
    ui['start-overlay'].classList.add('hidden');
    lastFrame = performance.now();
  } else {
    gameState.phase = 'starting';
    requestModelDecision();
  }
}
function endGame(reason) {
  gameState.phase = 'gameover';
  for (const controller of pending.values()) controller.abort();
  pending.clear();
  clearInterval(requestTimer);
  queuedAnswers = [];
  ui['start-overlay'].classList.remove('hidden');
  ui['overlay-kicker'].textContent = MODEL_LABEL;
  ui['overlay-title'].textContent = `Run ended at ${gameState.score}`;
  ui['overlay-copy'].textContent = reason === 'complete' ? 'Every pipe cleared.' : `Hit the ${reason}. Start a new matchup to try another course.`;
  report('runner-state', { phase: 'gameover', score: gameState.score });
}
function update(delta) {
  if (gameState.phase !== 'running') return;
  gameState.elapsed += delta;
  gameState.flash = Math.max(0, gameState.flash - delta);
  const bird = gameState.bird;
  bird.velocity += GRAVITY * delta;
  bird.y += bird.velocity * delta;
  bird.rotation = Math.min(1.35, bird.rotation + delta * 1.9);
  for (const pipe of gameState.pipes) {
    pipe.x -= PIPE_SPEED * delta;
    if (!pipe.scored && pipe.x + PIPE_WIDTH < BIRD_X - COLLISION_RADIUS) { pipe.scored = true; gameState.score += 1; }
  }
  if (bird.y - COLLISION_RADIUS < 0) { endGame('ceiling'); return; }
  if (bird.y + COLLISION_RADIUS > PLAY_BOTTOM) { endGame('ground'); return; }
  const pipe = gameState.pipes.find((candidate) => BIRD_X + COLLISION_RADIUS > candidate.x && BIRD_X - COLLISION_RADIUS < candidate.x + PIPE_WIDTH);
  if (pipe && (bird.y - COLLISION_RADIUS < pipe.gapTop || bird.y + COLLISION_RADIUS > pipe.gapBottom)) {
    endGame(bird.y < pipe.gapTop ? 'upper pipe' : 'lower pipe');
  } else if (gameState.score === gameState.pipes.length) endGame('complete');
}
function setText(element, value) {
  const next = String(value);
  if (element.textContent !== next) element.textContent = next;
}
function renderUI() {
  const ai = gameState.ai;
  setText(ui.score, gameState.score);
  setText(ui['stat-latency'], ai.latency === null ? '-' : `${ai.latency}ms`);
  setText(ui['stat-decisions'], ai.received);
  setText(ui['decision-counts'], `${pending.size} in flight · ${ai.discarded} superseded · ${ai.skipped} skipped · ${ai.errors} errors`);
  const action = gameState.phase === 'running' ? (ai.lastAction?.toUpperCase() || 'READY')
    : gameState.phase === 'gameover' ? 'ENDED' : gameState.phase === 'starting' ? 'THINK' : gameState.phase === 'aierror' ? 'ERROR' : 'READY';
  setText(ui['live-action'], gameState.flash > 0 ? 'FLAP' : action);
  setText(ui['run-status'], gameState.phase === 'running' ? ai.error ? 'API error' : 'Playing'
    : gameState.phase === 'gameover' ? 'Game over' : gameState.phase === 'starting' ? 'Connecting' : 'Ready');
  if (gameState.phase === 'starting' && gameState.elapsed === 0) {
    setText(ui['overlay-kicker'], 'Waiting for first decision');
    setText(ui['overlay-title'], 'THINKING…');
    setText(ui['overlay-copy'], 'The game begins when the model responds.');
  }
  if (ai.error) setText(ui['jev-state'], ai.error);
}
function drawBackground() {
  const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  sky.addColorStop(0, '#2571cf');
  sky.addColorStop(0.65, '#66c3e8');
  sky.addColorStop(1, '#c5eee4');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#d8f2df';
  for (const cloud of [{ x: 74, y: 132, s: 1 }, { x: 366, y: 220, s: 0.72 }, { x: 274, y: 65, s: 0.45 }]) {
    ctx.beginPath();
    ctx.ellipse(cloud.x, cloud.y, 48 * cloud.s, 13 * cloud.s, 0, 0, Math.PI * 2);
    ctx.ellipse(cloud.x - 27 * cloud.s, cloud.y + 3, 23 * cloud.s, 10 * cloud.s, 0, 0, Math.PI * 2);
    ctx.ellipse(cloud.x + 28 * cloud.s, cloud.y + 2, 28 * cloud.s, 11 * cloud.s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (let layer = 0; layer < 2; layer += 1) {
    ctx.fillStyle = layer ? '#7ccebb' : '#a1ded1';
    ctx.beginPath();
    ctx.moveTo(0, PLAY_BOTTOM);
    for (let x = 0; x <= WIDTH; x += 6) {
      ctx.lineTo(x, PLAY_BOTTOM - 25 - layer * 10 - Math.sin(x / 92 + layer * 2) * 24);
    }
    ctx.lineTo(WIDTH, PLAY_BOTTOM);
    ctx.closePath();
    ctx.fill();
  }
}

function drawPipe(pipe) {
  const pipeGradient = ctx.createLinearGradient(pipe.x, 0, pipe.x + PIPE_WIDTH, 0);
  pipeGradient.addColorStop(0, '#23895c');
  pipeGradient.addColorStop(0.45, '#6bdb86');
  pipeGradient.addColorStop(1, '#277b52');
  const capHeight = 27;
  ctx.fillStyle = pipeGradient;
  ctx.fillRect(pipe.x, 0, PIPE_WIDTH, pipe.gapTop);
  ctx.fillRect(pipe.x, pipe.gapBottom, PIPE_WIDTH, PLAY_BOTTOM - pipe.gapBottom);
  ctx.fillStyle = '#71df91';
  ctx.fillRect(pipe.x - 5, pipe.gapTop - capHeight, PIPE_WIDTH + 10, capHeight);
  ctx.fillRect(pipe.x - 5, pipe.gapBottom, PIPE_WIDTH + 10, capHeight);
  ctx.fillStyle = 'rgba(255,255,255,.17)';
  ctx.fillRect(pipe.x + 10, 0, 7, Math.max(0, pipe.gapTop - capHeight));
  ctx.fillRect(pipe.x + 10, pipe.gapBottom + capHeight, 7, Math.max(0, PLAY_BOTTOM - pipe.gapBottom - capHeight));
}

function drawGround() {
  ctx.fillStyle = '#d6bb6a';
  ctx.fillRect(0, PLAY_BOTTOM, WIDTH, GROUND_HEIGHT);
  ctx.fillStyle = '#7dbc65';
  ctx.fillRect(0, PLAY_BOTTOM, WIDTH, 15);
  ctx.fillStyle = 'rgba(95, 115, 58, .28)';
  for (let x = -30; x < WIDTH + 60; x += 42) {
    ctx.beginPath();
    ctx.moveTo(x, PLAY_BOTTOM + 15);
    ctx.lineTo(x + 18, PLAY_BOTTOM + 15);
    ctx.lineTo(x + 4, HEIGHT);
    ctx.lineTo(x - 14, HEIGHT);
    ctx.closePath();
    ctx.fill();
  }
}

function drawBird(y = gameState.bird.y, rotation = gameState.bird.rotation) {
  ctx.save();
  ctx.translate(BIRD_X, y);
  ctx.rotate(rotation);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#173049';
  ctx.lineWidth = 2;

  ctx.fillStyle = '#ffd36c';
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#ef9a46';
  ctx.beginPath();
  ctx.ellipse(-5, 7, 11, 5, -0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#f5a344';
  ctx.beginPath();
  ctx.moveTo(11, -2); ctx.lineTo(27, 2); ctx.lineTo(11, 7); ctx.closePath(); ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(7, -7, 5, 0, Math.PI * 2); ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#17283b';
  ctx.beginPath(); ctx.arc(8, -7, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function draw() {
  drawBackground();
  if (gameState.phase !== 'ready') {
    for (const pipe of gameState.pipes) {
      if (pipe.x < WIDTH + 5 && pipe.x + PIPE_WIDTH > -5) drawPipe(pipe);
    }
  }
  drawGround();
  if (gameState.phase === 'ready') {
    const bob = Math.sin(performance.now() / 360) * 12;
    drawBird(HEIGHT * 0.45 + bob, -0.08);
  } else {
    drawBird();
  }
  if (gameState.flash > 0) {
    ctx.fillStyle = `rgba(255, 239, 180, ${gameState.flash * 0.35})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

function tick(now) {
  if (gameState.phase === 'armed' && scheduledLaunch !== null && Date.now() >= scheduledLaunch) {
    launchGame(now, Date.now() - scheduledLaunch);
    scheduledLaunch = null;
  }
  if (gameState.phase === 'running') {
    accumulator += Math.max(0, (now - lastFrame) / 1000)
      * (gameState.mode === 'physics' ? MODEL_GAME_SPEED : 1);
    while (accumulator >= 1 / 120 && gameState.phase === 'running') {
      if (gameState.mode === 'physics') consumeModelAnswers();
      update(1 / 120);
      accumulator -= 1 / 120;
    }
    lastFrame = now;
  } else lastFrame = now;
  renderUI();
  draw();
}
function loop(now) {
  tick(now);
  requestAnimationFrame(loop);
}
window.addEventListener('message', (event) => {
  if (!EMBEDDED || event.origin !== location.origin || event.source !== window.parent) return;
  const data = event.data;
  if (data?.type === 'comparison-prepare' && typeof data.matchId === 'string' && Number.isInteger(data.seed)) {
    matchId = data.matchId;
    resetGame('physics', data.seed);
    startGame();
  }
  if (data?.matchId !== matchId) return;
  if (data.type === 'comparison-launch' && gameState.phase === 'armed'
      && Number.isFinite(data.launchAt)) scheduledLaunch = data.launchAt;
});
ui['start-button'].addEventListener('click', () => {
  if (EMBEDDED) return;
  resetGame(gameState.mode);
  startGame();
});
ui['human-mode'].addEventListener('click', () => resetGame('human'));
ui['physics-mode'].addEventListener('click', () => resetGame('physics'));
function humanFlap() {
  if (gameState.mode !== 'human') return;
  if (gameState.phase !== 'running') { resetGame('human'); startGame(); }
  applyFlap();
}
canvas.addEventListener('pointerdown', humanFlap);
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' || event.code === 'ArrowUp') { event.preventDefault(); humanFlap(); }
});
resetGame(RUNNER ? 'physics' : 'human');
requestAnimationFrame(loop);
setInterval(() => {
  const now = performance.now();
  if (now - lastFrame >= 50) tick(now);
}, 50);
report('runner-ready');

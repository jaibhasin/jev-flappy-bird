import { MoveHistory } from './ai-history.js';

const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');

const WIDTH = canvas.width;
const HEIGHT = canvas.height;
const GROUND_HEIGHT = 92;
const PLAY_BOTTOM = HEIGHT - GROUND_HEIGHT;
const SEED = 1337;
const PIPE_WIDTH = 76;
const PIPE_GAP = 178;
const PIPE_SPACING = 255;
const PIPE_SPEED = 178;
const BIRD_X = 122;
const BIRD_RADIUS = 16;
const COLLISION_RADIUS = 12;
const GRAVITY = 950;
const FLAP_VELOCITY = -330;
const AI_REQUEST_INTERVAL_MS = 50;
const INITIAL_LATENCY_ESTIMATE_MS = 280;
const PLAN_HORIZON_MS = 3200;
const MAX_PLAN_OPTIONS = 32;
const JEV_REQUEST_TIMEOUT_MS = 6000;
const physicsHistory = new MoveHistory(100);

const dom = {
  score: document.querySelector('#score'),
  seedValue: document.querySelector('#seed-value'),
  runStatus: document.querySelector('#run-status'),
  overlay: document.querySelector('#start-overlay'),
  overlayKicker: document.querySelector('#overlay-kicker'),
  overlayTitle: document.querySelector('#overlay-title'),
  overlayCopy: document.querySelector('#overlay-copy'),
  startButton: document.querySelector('#start-button'),
  humanMode: document.querySelector('#human-mode'),
  physicsMode: document.querySelector('#physics-mode'),
  controlHint: document.querySelector('#control-hint'),
  jevQuestion: document.querySelector('#jev-question'),
  jevState: document.querySelector('#jev-state'),
  jevChoices: document.querySelector('#jev-choices'),
  jevAction: document.querySelector('#jev-action'),
  jevProbabilities: document.querySelector('#jev-probabilities'),
};

let gameState;
let lastFrame = performance.now();
let animationFrame;
let aiRunToken = 0;
let jevLogs = [];
const jevClientId = crypto.randomUUID();
const jevResponseWaiters = new Map();
let jevEventSource;
let jevStreamReady = false;
let jevRequestId = 0;
let jevInFlightCount = 0;

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ (value >>> 15), 1 | value);
    result ^= result + Math.imul(result ^ (result >>> 7), 61 | result);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function createPipes() {
  const random = seededRandom(SEED);
  const pipes = [];
  for (let index = 0; index < 40; index += 1) {
    const center = 155 + random() * 305;
    pipes.push({
      x: WIDTH + 95 + index * PIPE_SPACING,
      gapTop: center - PIPE_GAP / 2,
      gapBottom: center + PIPE_GAP / 2,
      scored: false,
    });
  }
  return pipes;
}

function createAIState() {
  return {
    lastAction: 'wait',
    confidence: null,
    latency: null,
    error: null,
    offline: false,
    retryAt: 0,
    runId: null,
    pendingMove: null,
    trajectoryVersion: 0,
    latencyEstimate: INITIAL_LATENCY_ESTIMATE_MS,
    latencySamples: [],
    gameTimeMs: 0,
    planEndMs: 0,
    nextDecisionAtMs: null,
    plannedActions: [],
    runToken: ++aiRunToken,
  };
}

function resetGame(mode = gameState?.mode || 'human') {
  if (gameState?.ai?.requestTimer) clearInterval(gameState.ai.requestTimer);
  gameState = {
    mode,
    phase: 'ready',
    score: 0,
    bird: { y: HEIGHT * 0.45, velocity: 0, rotation: 0 },
    pipes: createPipes(),
    flash: 0,
    ai: createAIState(),
  };
  dom.runStatus.textContent = 'Ready';
  dom.overlay.classList.remove('hidden');
  showReadyOverlay();
  applyModeUI();
  updateUI();
}

function startGame() {
  if (gameState.phase === 'running' || gameState.phase === 'starting') return;
  if (gameState.phase === 'gameover' || gameState.phase === 'aierror') resetGame();
  gameState.phase = gameState.mode === 'physics' ? 'starting' : 'running';
  dom.overlay.classList.add('hidden');
  dom.runStatus.textContent = 'Flying';
  if (gameState.mode === 'physics') {
    gameState.ai.runId = physicsHistory.startRun();
    gameState.ai.requestTimer = setInterval(requestAIDecision, AI_REQUEST_INTERVAL_MS);
    requestAIDecision();
  }
  updateUI();
}

function flap() {
  if (gameState.mode === 'physics') return;
  if (gameState.phase !== 'running') {
    startGame();
  }
  applyFlap();
}

function applyFlap() {
  if (gameState.phase === 'running') {
    gameState.bird.velocity = FLAP_VELOCITY;
    gameState.bird.rotation = -0.35;
    gameState.flash = 0.1;
  }
}

function showReadyOverlay() {
  const isPhysics = gameState.mode === 'physics';
  dom.overlayKicker.textContent = isPhysics ? 'With physics' : 'Human mode';
  dom.overlayTitle.textContent = 'FLAPPY BIRD';
  dom.overlayCopy.textContent = isPhysics ? 'Jev will choose when to flap using the game physics.' : 'Tap the game or press Space or Up Arrow to flap.';
  dom.startButton.innerHTML = isPhysics ? 'Start AI run <span>↗</span>' : 'Start run <span>↗</span>';
}

function applyModeUI() {
  const isPhysics = gameState.mode === 'physics';
  document.body.classList.toggle('ai-mode', isPhysics);
  dom.humanMode.classList.toggle('active', !isPhysics);
  dom.physicsMode.classList.toggle('active', isPhysics);
  dom.controlHint.innerHTML = isPhysics ? 'Jev is flying this run' : '<kbd>Space</kbd> or <kbd>↑</kbd> or click to flap';
}

function setMode(mode) {
  if (mode === gameState.mode) return;
  resetGame(mode);
}

function getNextPipeFor(world) {
  return world.pipes.find((pipe) => pipe.x + PIPE_WIDTH >= BIRD_X - BIRD_RADIUS) || null;
}

function getNextPipe() {
  return getNextPipeFor(gameState);
}

function update(delta) {
  if (gameState.phase !== 'running') return;
  if (gameState.mode === 'physics') {
    advanceAIPhysics(delta);
  } else {
    advancePhysics(delta);
  }
  updateUI();
}

function advanceWorld(world, delta) {
  let elapsed = 0;
  const maxSubstep = 1 / 120;

  while (elapsed < delta) {
    const step = Math.min(maxSubstep, delta - elapsed);
    world.flash = Math.max(0, world.flash - step);
    world.bird.velocity += GRAVITY * step;
    world.bird.y += world.bird.velocity * step;
    world.bird.rotation = Math.min(1.35, world.bird.rotation + step * 1.9);

    for (const pipe of world.pipes) {
      pipe.x -= PIPE_SPEED * step;
      if (!pipe.scored && pipe.x + PIPE_WIDTH < BIRD_X - BIRD_RADIUS) {
        pipe.scored = true;
        world.score += 1;
      }
    }

    elapsed += step;
    const collision = getCollisionReasonFor(world);
    const complete = world.pipes.every((pipe) => pipe.x + PIPE_WIDTH < BIRD_X - BIRD_RADIUS);
    if (collision) {
      return { elapsedSeconds: elapsed, collision };
    }
    if (complete) return { elapsedSeconds: elapsed, collision: null, complete: true };
  }

  return { elapsedSeconds: elapsed, collision: null, complete: false };
}

function advancePhysics(delta) {
  const result = advanceWorld(gameState, delta);
  if (gameState.mode === 'physics' && gameState.ai.pendingMove) {
    gameState.ai.pendingMove.elapsedSeconds += result.elapsedSeconds;
  }
  if (result.collision) endGame(result.collision);
  if (result.complete) completeGame();
  return result;
}

function getCollisionReasonFor(world) {
  const pipe = getNextPipeFor(world);
  const birdHitsPipe = pipe && BIRD_X + COLLISION_RADIUS > pipe.x && BIRD_X - COLLISION_RADIUS < pipe.x + PIPE_WIDTH && (world.bird.y - COLLISION_RADIUS < pipe.gapTop || world.bird.y + COLLISION_RADIUS > pipe.gapBottom);
  if (birdHitsPipe) return world.bird.y < pipe.gapTop ? 'upper_pipe' : 'lower_pipe';
  if (world.bird.y - COLLISION_RADIUS < 0) return 'ceiling';
  if (world.bird.y + COLLISION_RADIUS > PLAY_BOTTOM) return 'ground';
  return null;
}

function endGame(reason = 'unknown') {
  if (gameState.ai.requestTimer) clearInterval(gameState.ai.requestTimer);
  finishPendingAIMove(reason);
  gameState.phase = 'gameover';
  gameState.crashReason = reason;
  dom.runStatus.textContent = 'Crashed';
  dom.overlayKicker.textContent = gameState.mode === 'physics' ? 'With physics' : 'Human mode';
  dom.overlayTitle.textContent = `Run ended at ${gameState.score}`;
  dom.overlayCopy.textContent = gameState.mode === 'physics' ? `Jev hit the ${reason.replace('_', ' ')}. Try again to use the saved history.` : 'Same seed, same pipes. Try a different rhythm.';
  dom.startButton.innerHTML = gameState.mode === 'physics' ? 'Try AI again <span>↗</span>' : 'Try again <span>↗</span>';
  dom.overlay.classList.remove('hidden');
  updateUI();
}

function completeGame() {
  finishPendingAIMove();
  gameState.phase = 'gameover';
  dom.runStatus.textContent = 'Complete';
  dom.overlayKicker.textContent = gameState.mode === 'physics' ? 'With physics' : 'Human mode';
  dom.overlayTitle.textContent = `Run complete at ${gameState.score}`;
  dom.overlayCopy.textContent = 'You cleared every pipe in this seeded run.';
  dom.startButton.innerHTML = gameState.mode === 'physics' ? 'Run it again <span>↗</span>' : 'Play again <span>↗</span>';
  dom.overlay.classList.remove('hidden');
  updateUI();
}

function pauseForAIError(message) {
  if (gameState.ai.requestTimer) clearInterval(gameState.ai.requestTimer);
  gameState.phase = 'aierror';
  gameState.ai.error = message;
  dom.runStatus.textContent = 'AI paused';
  dom.overlayKicker.textContent = 'With physics';
  dom.overlayTitle.textContent = 'AI CONNECTION PAUSED';
  dom.overlayCopy.textContent = message;
  dom.startButton.innerHTML = 'Try AI again <span>↗</span>';
  dom.overlay.classList.remove('hidden');
}

function addJevLog(trace) {
  if (!trace) return;
  jevLogs = [...jevLogs, trace].slice(-50);
  renderJevTrace(trace);
}

function formatProbabilities(probabilities = {}) {
  const entries = Object.entries(probabilities);
  if (!entries.length) return 'Probabilities: unavailable';
  return `Probabilities: ${entries.map(([choice, probability]) => {
    const value = Number(probability);
    const formatted = Number.isFinite(value) ? `${Math.round((value <= 1 ? value * 100 : value))}%` : String(probability);
    return `${choice} ${formatted}`;
  }).join(' · ')}`;
}

function renderJevTrace(trace) {
  const modelRequest = trace.request || {};
  const planQuestion = modelRequest.questions?.plan?.instructions?.question;
  const question = planQuestion || modelRequest.questions?.action?.instructions?.question;
  const choices = Object.keys(modelRequest.questions?.plan?.criteria || modelRequest.questions?.action?.criteria || {});
  const state = modelRequest.state || {};
  const result = trace.result || {};
  const requestSummary = [
    state.bird_y === undefined ? '' : `bird ${state.bird_y}px`,
    state.bird_velocity === undefined ? '' : `speed ${state.bird_velocity}px/s`,
    state.pipe_distance == null ? '' : `pipe ${state.pipe_distance}px`,
    state.gap_offset === undefined ? '' : `gap offset ${state.gap_offset}px`,
  ].filter(Boolean).join(' · ');
  if (question) dom.jevQuestion.textContent = question;
  dom.jevState.textContent = trace.error || requestSummary || 'Game state sent';
  if (choices.length) dom.jevChoices.textContent = planQuestion ? `Collision-free plans considered: ${choices.length}` : `Choices: ${choices.join(' · ')}`;
  dom.jevAction.textContent = result.plan_id
    ? `${result.plan_id}: ${result.actions_ms?.join(', ') || 'wait'} ms`
    : result.action || (trace.ok ? '-' : 'Request failed');
  const selectedProbability = result.plan_id ? result.probabilities?.[result.plan_id] : null;
  dom.jevProbabilities.textContent = result.plan_id && selectedProbability !== undefined
    ? `Selected plan probability: ${Math.round(Number(selectedProbability) * 100)}%`
    : formatProbabilities(result.probabilities);
}

async function loadJevLogs() {
  try {
    const response = await fetch('/api/jev/logs');
    const payload = await response.json();
    if (response.ok && Array.isArray(payload.logs)) {
      jevLogs = payload.logs;
      if (jevLogs.length) renderJevTrace(jevLogs[jevLogs.length - 1]);
    }
  } catch {
    // The game remains usable if the local log endpoint is unavailable.
  }
}

function makeClientTrace(request, response, ok, error, duration) {
  return {
    id: `client-${Date.now()}`,
    at: new Date().toISOString(),
    duration_ms: Math.round(duration),
    ok,
    request,
    response,
    result: ok ? response : undefined,
    error,
  };
}

function getGameSnapshot(world = gameState) {
  const pipe = getNextPipeFor(world);
  const pipeIndex = pipe ? world.pipes.indexOf(pipe) : -1;
  const gapCenter = pipe ? (pipe.gapTop + pipe.gapBottom) / 2 : world.bird.y;
  return {
    score: world.score,
    bird_y: Math.round(world.bird.y),
    bird_velocity: Math.round(world.bird.velocity),
    pipe_id: pipeIndex,
    pipe_distance: pipe ? Math.max(0, Math.round(pipe.x - BIRD_X)) : null,
    gap_top: pipe ? Math.round(pipe.gapTop) : null,
    gap_bottom: pipe ? Math.round(pipe.gapBottom) : null,
    gap_offset: Math.round(world.bird.y - gapCenter),
  };
}

export function getProjectedState(seconds, world = gameState) {
  const shift = PIPE_SPEED * seconds;
  const pipeIndex = world.pipes.findIndex((candidate) => candidate.x - shift + PIPE_WIDTH >= BIRD_X - BIRD_RADIUS);
  const pipe = world.pipes[pipeIndex];
  let projectedY = world.bird.y;
  let projectedVelocity = world.bird.velocity;
  for (let elapsed = 0; elapsed < seconds;) {
    const step = Math.min(1 / 120, seconds - elapsed);
    projectedVelocity += GRAVITY * step;
    projectedY += projectedVelocity * step;
    elapsed += step;
  }
  const projectedPipeX = pipe ? pipe.x - shift : null;
  const clearanceAbove = pipe ? Math.round(projectedY - COLLISION_RADIUS - pipe.gapTop) : null;
  const clearanceBelow = pipe ? Math.round(pipe.gapBottom - projectedY - COLLISION_RADIUS) : null;

  return {
    after_ms: Math.round(seconds * 1000),
    bird_y: Math.round(projectedY),
    bird_velocity: Math.round(projectedVelocity),
    pipe_id: pipeIndex,
    pipe_distance: projectedPipeX === null ? null : Math.max(0, Math.round(projectedPipeX - BIRD_X)),
    gap_top: pipe ? Math.round(pipe.gapTop) : null,
    gap_bottom: pipe ? Math.round(pipe.gapBottom) : null,
    gap_offset: pipe ? Math.round(projectedY - (pipe.gapTop + pipe.gapBottom) / 2) : 0,
    clearance_above: clearanceAbove,
    clearance_below: clearanceBelow,
    position: !pipe ? null : clearanceAbove < 0 ? 'above the gap' : clearanceBelow < 0 ? 'below the gap' : clearanceAbove < clearanceBelow ? 'inside the gap, upper half' : 'inside the gap, lower half',
    motion: projectedVelocity < -60 ? 'rising' : projectedVelocity > 250 ? 'falling fast' : projectedVelocity > 60 ? 'falling' : 'level',
  };
}

function getAIState(latencyProjection) {
  return {
    ...latencyProjection,
    physics: {
      gravity: GRAVITY,
      flap_velocity: FLAP_VELOCITY,
      pipe_speed: PIPE_SPEED,
      decision_interval_ms: AI_REQUEST_INTERVAL_MS,
      positive_y_direction: 'down',
    },
  };
}

function copyWorld(world) {
  return {
    score: world.score,
    bird: { ...world.bird },
    pipes: world.pipes.map((pipe) => ({ ...pipe })),
    flash: world.flash || 0,
  };
}

function simulateWorld(world, actionTimesMs, durationMs) {
  const simulation = copyWorld(world);
  const actions = [...actionTimesMs].sort((a, b) => a - b);
  let nextAction = 0;
  let elapsedMs = 0;
  let minimumClearance = Number.POSITIVE_INFINITY;
  const stepMs = 1000 / 120;

  while (elapsedMs < durationMs) {
    while (actions[nextAction] !== undefined && actions[nextAction] <= elapsedMs + 0.001) {
      simulation.bird.velocity = FLAP_VELOCITY;
      nextAction += 1;
    }
    const step = Math.min(stepMs, durationMs - elapsedMs) / 1000;
    const result = advanceWorld(simulation, step);
    if (result.collision) return { safe: false, minimumClearance };
    elapsedMs += step * 1000;

    const pipe = getNextPipeFor(simulation);
    if (pipe && BIRD_X + COLLISION_RADIUS > pipe.x && BIRD_X - COLLISION_RADIUS < pipe.x + PIPE_WIDTH) {
      minimumClearance = Math.min(minimumClearance, simulation.bird.y - COLLISION_RADIUS - pipe.gapTop, pipe.gapBottom - simulation.bird.y - COLLISION_RADIUS);
    }
  }
  return { safe: true, minimumClearance: Number.isFinite(minimumClearance) ? Math.round(minimumClearance) : 999 };
}

function projectCommittedPlan(targetGameTimeMs) {
  const world = copyWorld(gameState);
  let cursorMs = gameState.ai.gameTimeMs;
  const pending = [...gameState.ai.plannedActions].sort((a, b) => a.atMs - b.atMs);
  for (const action of pending) {
    if (action.atMs > targetGameTimeMs) break;
    const result = advanceWorld(world, Math.max(0, action.atMs - cursorMs) / 1000);
    if (result.collision || result.complete) return null;
    cursorMs = action.atMs;
    world.bird.velocity = FLAP_VELOCITY;
  }
  const result = advanceWorld(world, Math.max(0, targetGameTimeMs - cursorMs) / 1000);
  if (result.collision || result.complete) return null;
  return world;
}

function buildCandidatePlans(world, latencyBudgetMs) {
  const schedules = [[]];
  const seenSchedules = new Set(['']);
  for (let intervalMs = 400; intervalMs <= 1000; intervalMs += 50) {
    for (let phaseMs = 0; phaseMs < intervalMs; phaseMs += 100) {
      const actionsMs = [];
      for (let actionAtMs = phaseMs; actionAtMs < PLAN_HORIZON_MS; actionAtMs += intervalMs) actionsMs.push(actionAtMs);
      const key = actionsMs.join(',');
      if (!seenSchedules.has(key)) {
        schedules.push(actionsMs);
        seenSchedules.add(key);
      }
    }
  }

  const candidates = schedules.map((actionsMs) => {
    const result = simulateWorld(world, actionsMs, PLAN_HORIZON_MS + latencyBudgetMs);
    return result.safe ? { actions_ms: actionsMs, minimum_clearance: result.minimumClearance, horizon_ms: PLAN_HORIZON_MS + latencyBudgetMs } : null;
  }).filter(Boolean);
  candidates.sort((a, b) => b.minimum_clearance - a.minimum_clearance);

  const selected = [];
  const seen = new Set();
  for (let index = 0; index < candidates.length && selected.length < MAX_PLAN_OPTIONS; index += 1) {
    const candidate = candidates[Math.floor(index * candidates.length / MAX_PLAN_OPTIONS)];
    const key = candidate.actions_ms.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push({ id: `plan_${selected.length + 1}`, ...candidate });
  }
  return selected;
}

function getLatencyBudget() {
  const samples = [...gameState.ai.latencySamples].sort((a, b) => a - b);
  const p90 = samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.9) - 1)] : INITIAL_LATENCY_ESTIMATE_MS;
  return Math.min(1800, Math.max(600, p90 + 150, gameState.ai.latencyEstimate * 1.5));
}

function recordAIStep(action, before, after, stepResult, requestLatency) {
  physicsHistory.add({
    seed: SEED,
    before,
    action,
    after,
    elapsed_game_ms: Math.round(stepResult.elapsedSeconds * 1000),
    request_latency_ms: requestLatency,
    result: {
      survived: !stepResult.collision,
      pipes_passed: after.score - before.score,
      crash_reason: stepResult.collision,
    },
  }, gameState.ai.runId);
}

function finishPendingAIMove(collision = null) {
  const pendingMove = gameState.ai.pendingMove;
  if (!pendingMove) return;

  recordAIStep(
    pendingMove.action,
    pendingMove.before,
    getGameSnapshot(),
    {
      elapsedSeconds: pendingMove.elapsedSeconds,
      collision,
    },
    pendingMove.requestLatency,
  );
  gameState.ai.pendingMove = null;
}

function applyAIDecision(action, requestLatency) {
  finishPendingAIMove();
  const before = getGameSnapshot();
  if (action === 'flap') applyFlap();
  gameState.ai.lastAction = action;
  gameState.ai.pendingMove = {
    action,
    before,
    elapsedSeconds: 0,
    requestLatency,
  };
}

function advanceAIPhysics(delta) {
  let remaining = delta;
  const actions = gameState.ai.plannedActions.sort((a, b) => a.atMs - b.atMs);
  while (actions.length && actions[0].atMs <= gameState.ai.gameTimeMs + remaining) {
    const action = actions.shift();
    const untilAction = Math.max(0, (action.atMs - gameState.ai.gameTimeMs) / 1000);
    if (untilAction > 0) {
      const result = advancePhysics(untilAction);
      gameState.ai.gameTimeMs += result.elapsedSeconds * 1000;
      remaining -= result.elapsedSeconds;
      if (result.collision || result.complete || gameState.phase !== 'running') return;
    }
    applyAIDecision('flap', action.latency);
  }
  if (remaining > 0 && gameState.phase === 'running') {
    const result = advancePhysics(remaining);
    gameState.ai.gameTimeMs += result.elapsedSeconds * 1000;
  }
}

function settleJevResponse(requestId, error, packet) {
  const waiter = jevResponseWaiters.get(requestId);
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  jevResponseWaiters.delete(requestId);
  if (error) waiter.reject(error);
  else waiter.resolve(packet);
}

function connectJevEventStream() {
  if (typeof EventSource === 'undefined') return;
  jevEventSource = new EventSource(`/api/jev/stream?client=${encodeURIComponent(jevClientId)}`);
  jevEventSource.onopen = () => {
    jevStreamReady = true;
    if (gameState?.mode === 'physics' && ['starting', 'running'].includes(gameState.phase)) {
      gameState.ai.error = null;
      gameState.ai.offline = false;
      gameState.ai.retryAt = 0;
      requestAIDecision();
    }
    updateUI();
  };
  jevEventSource.onmessage = (event) => {
    try {
      const packet = JSON.parse(event.data);
      settleJevResponse(packet.rid, null, packet);
    } catch {
      // Ignore malformed stream events and keep the connection available for later answers.
    }
  };
  jevEventSource.onerror = () => {
    jevStreamReady = false;
    if (gameState?.mode === 'physics' && gameState.phase === 'running') {
      gameState.ai.error = 'Jev answer stream reconnecting';
      gameState.ai.offline = true;
      gameState.ai.retryAt = performance.now() + 500;
    }
    updateUI();
  };
}

function postJevDecision(requestBody) {
  const requestId = ++jevRequestId;
  const body = { ...requestBody, client: jevClientId, rid: requestId };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      settleJevResponse(requestId, new Error('Jev did not answer within 6 seconds.'));
    }, JEV_REQUEST_TIMEOUT_MS);
    jevResponseWaiters.set(requestId, { resolve, reject, timeout });

    fetch('/api/jev/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (response) => {
      if (response.status === 202) return;
      const payload = await response.json().catch(() => ({}));
      settleJevResponse(requestId, new Error(payload.error || 'Jev request was rejected.'));
    }).catch((error) => {
      settleJevResponse(requestId, error);
    });
  });
}

async function requestAIDecision() {
  if (gameState.mode !== 'physics' || !['starting', 'running'].includes(gameState.phase) || !jevStreamReady) return;
  if (jevInFlightCount > 0) return;
  if (performance.now() < gameState.ai.retryAt) return;

  const aiState = gameState.ai;
  const runToken = aiState.runToken;
  const trajectoryVersion = aiState.trajectoryVersion;
  const startedAt = performance.now();
  const latencyBudgetMs = getLatencyBudget();
  const targetGameTimeMs = gameState.phase === 'starting'
    ? aiState.gameTimeMs
    : Math.max(aiState.nextDecisionAtMs ?? (aiState.planEndMs + latencyBudgetMs), aiState.gameTimeMs + latencyBudgetMs);
  const projectedWorld = projectCommittedPlan(targetGameTimeMs);
  if (!projectedWorld) {
    pauseForAIError('The committed plan does not safely reach the next Jev decision point.');
    return;
  }
  const plans = buildCandidatePlans(projectedWorld, latencyBudgetMs);
  if (!plans.length) {
    pauseForAIError('No collision-free Jev plan options were available at the next decision point.');
    return;
  }
  const state = {
    ...getAIState(getProjectedState(0, projectedWorld)),
    decision_at_game_ms: Math.round(targetGameTimeMs),
    committed_plan_end_ms: Math.round(aiState.planEndMs),
    planning_horizon_ms: PLAN_HORIZON_MS,
    candidate_plans: plans.map(({ id, actions_ms, minimum_clearance, horizon_ms }) => ({ id, actions_ms, minimum_clearance, horizon_ms })),
  };
  const requestBody = {
    state,
    plans,
    trajectory_version: trajectoryVersion,
  };
  jevInFlightCount += 1;
  updateUI();

  let traceRecorded = false;
  let requestAgain = false;
  try {
    const event = await postJevDecision(requestBody);
    const payload = event.body || {};
    if (payload.trace) {
      addJevLog(payload.trace);
      traceRecorded = true;
    }
    if (event.status !== 200) throw new Error(payload.error || 'Jev could not make a decision.');
    if (gameState.ai.runToken !== runToken || !['starting', 'running'].includes(gameState.phase) || gameState.mode !== 'physics') return;
    const selectedPlan = plans.find((plan) => plan.id === payload.plan_id);
    if (payload.action !== 'plan' || !selectedPlan || payload.trajectory_version !== trajectoryVersion) throw new Error('Jev returned an invalid plan.');

    gameState.ai.confidence = payload.confidence;
    const requestLatency = performance.now() - startedAt;
    gameState.ai.latency = Math.round(requestLatency);
    aiState.latencyEstimate = Math.round(aiState.latencyEstimate * 0.8 + Math.min(requestLatency, 1800) * 0.2);
    aiState.latencySamples.push(requestLatency);
    aiState.latencySamples = aiState.latencySamples.slice(-12);
    gameState.ai.error = null;
    gameState.ai.offline = false;
    gameState.ai.retryAt = 0;
    if (targetGameTimeMs < aiState.gameTimeMs) throw new Error('Jev plan arrived after its projected decision time.');
    aiState.plannedActions.push(...selectedPlan.actions_ms.map((offsetMs) => ({ atMs: targetGameTimeMs + offsetMs, latency: requestLatency })));
    aiState.planEndMs = targetGameTimeMs + PLAN_HORIZON_MS;
    aiState.nextDecisionAtMs = aiState.planEndMs + latencyBudgetMs;
    aiState.trajectoryVersion += 1;
    if (gameState.phase === 'starting') gameState.phase = 'running';
    requestAgain = true;
  } catch (error) {
    if (!traceRecorded) addJevLog(makeClientTrace(requestBody, null, false, error.message, performance.now() - startedAt));
    if (gameState.ai.runToken === runToken && ['starting', 'running'].includes(gameState.phase)) {
      gameState.ai.error = error.message;
      gameState.ai.offline = true;
      gameState.ai.retryAt = performance.now() + 500;
    }
  } finally {
    jevInFlightCount = Math.max(0, jevInFlightCount - 1);
    updateUI();
    if (requestAgain) requestAIDecision();
  }
}

function updateUI() {
  if (!gameState) return;
  dom.score.textContent = gameState.score;
  dom.runStatus.textContent = gameState.phase === 'running'
    ? gameState.ai.offline && gameState.mode === 'physics' ? 'Jev offline' : 'Playing'
    : gameState.phase === 'starting' ? 'Waiting for Jev'
    : gameState.phase === 'gameover' ? 'Game over' : gameState.phase === 'aierror' ? 'Paused' : 'Ready';
  if (gameState.mode === 'physics' && gameState.ai.offline) {
    dom.jevState.textContent = `${gameState.ai.error}. Retrying shortly.`;
  }
}

function drawBackground() {
  const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  sky.addColorStop(0, '#162d4b');
  sky.addColorStop(0.65, '#4d8baa');
  sky.addColorStop(1, '#87b8af');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  ctx.globalAlpha = 0.42;
  ctx.fillStyle = '#d8f2df';
  for (const cloud of [{ x: 74, y: 132, s: 1 }, { x: 366, y: 220, s: 0.72 }, { x: 274, y: 65, s: 0.45 }]) {
    ctx.beginPath();
    ctx.ellipse(cloud.x, cloud.y, 48 * cloud.s, 13 * cloud.s, 0, 0, Math.PI * 2);
    ctx.ellipse(cloud.x - 27 * cloud.s, cloud.y + 3, 23 * cloud.s, 10 * cloud.s, 0, 0, Math.PI * 2);
    ctx.ellipse(cloud.x + 28 * cloud.s, cloud.y + 2, 28 * cloud.s, 11 * cloud.s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawPipe(pipe) {
  const pipeGradient = ctx.createLinearGradient(pipe.x, 0, pipe.x + PIPE_WIDTH, 0);
  pipeGradient.addColorStop(0, '#276b58');
  pipeGradient.addColorStop(0.45, '#4cae78');
  pipeGradient.addColorStop(1, '#225b4d');
  const capHeight = 27;
  ctx.fillStyle = pipeGradient;
  ctx.fillRect(pipe.x, 0, PIPE_WIDTH, pipe.gapTop);
  ctx.fillRect(pipe.x, pipe.gapBottom, PIPE_WIDTH, PLAY_BOTTOM - pipe.gapBottom);
  ctx.fillStyle = '#5bc788';
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
    for (const pipe of gameState.pipes) drawPipe(pipe);
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

function loop(now) {
  const delta = Math.min((now - lastFrame) / 1000, 0.034);
  lastFrame = now;
  update(delta);
  draw();
  animationFrame = requestAnimationFrame(loop);
}

dom.startButton.addEventListener('click', startGame);
dom.humanMode.addEventListener('click', () => setMode('human'));
dom.physicsMode.addEventListener('click', () => setMode('physics'));
canvas.addEventListener('pointerdown', flap);
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' || event.code === 'ArrowUp') {
    event.preventDefault();
    flap();
  }
});

resetGame();
loadJevLogs();
connectJevEventStream();
cancelAnimationFrame(animationFrame);
animationFrame = requestAnimationFrame(loop);

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
const AI_STEP_SECONDS = 1 / 7;
const AI_STEP_MS = AI_STEP_SECONDS * 1000;
const AI_PLAN_STEPS = 7;
const AI_PROJECTION_TIMES = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
const physicsHistory = new MoveHistory(100);
const actionSequences = createActionSequences();

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
  inspectorTitle: document.querySelector('#inspector-title'),
  actionLabel: document.querySelector('#action-label'),
  nextAction: document.querySelector('#next-action'),
  birdHeight: document.querySelector('#bird-height'),
  birdSpeed: document.querySelector('#bird-speed'),
  pipeDistance: document.querySelector('#pipe-distance'),
  gapOffset: document.querySelector('#gap-offset'),
  aiConfidence: document.querySelector('#ai-confidence'),
  aiLatency: document.querySelector('#ai-latency'),
  historyCount: document.querySelector('#history-count'),
  inspectorNote: document.querySelector('#inspector-note p'),
  jevLogCount: document.querySelector('#jev-log-count'),
  jevLogs: document.querySelector('#jev-logs'),
  clearJevLogs: document.querySelector('#clear-jev-logs'),
  resetButton: document.querySelector('#reset-button'),
  clearExperience: document.querySelector('#clear-experience'),
};

let gameState;
let lastFrame = performance.now();
let animationFrame;
let aiRunToken = 0;
let jevLogs = [];

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
    requestInFlight: false,
    lastAction: 'wait',
    confidence: null,
    latency: null,
    error: null,
    runId: null,
    pendingMove: null,
    actionQueue: [],
    timeToNextAction: 0,
    runToken: ++aiRunToken,
  };
}

function resetGame(mode = gameState?.mode || 'human') {
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
  if (gameState.phase === 'running') return;
  if (gameState.phase === 'gameover' || gameState.phase === 'aierror') resetGame();
  gameState.phase = 'running';
  dom.overlay.classList.add('hidden');
  dom.runStatus.textContent = 'Flying';
  if (gameState.mode === 'physics') {
    gameState.ai.runId = physicsHistory.startRun();
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
  dom.inspectorTitle.textContent = isPhysics ? "Jev's controls" : 'Your controls';
  dom.controlHint.innerHTML = isPhysics ? 'Jev is flying this run' : '<kbd>Space</kbd> or <kbd>↑</kbd> or click to flap';
}

function setMode(mode) {
  if (mode === gameState.mode) return;
  resetGame(mode);
}

function getNextPipeFor(world) {
  return world.pipes.find((pipe) => pipe.x + PIPE_WIDTH >= BIRD_X - BIRD_RADIUS) || world.pipes[world.pipes.length - 1];
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
    if (collision) {
      return { elapsedSeconds: elapsed, collision };
    }
  }

  return { elapsedSeconds: elapsed, collision: null };
}

function advancePhysics(delta) {
  const result = advanceWorld(gameState, delta);
  if (gameState.mode === 'physics' && gameState.ai.pendingMove) {
    gameState.ai.pendingMove.elapsedSeconds += result.elapsedSeconds;
  }
  if (result.collision) endGame(result.collision);
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

function pauseForAIError(message) {
  gameState.phase = 'aierror';
  gameState.ai.error = message;
  dom.runStatus.textContent = 'AI paused';
  dom.overlayKicker.textContent = 'With physics';
  dom.overlayTitle.textContent = 'AI CONNECTION PAUSED';
  dom.overlayCopy.textContent = message;
  dom.startButton.innerHTML = 'Try AI again <span>↗</span>';
  dom.overlay.classList.remove('hidden');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function prettyJson(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function formatTraceTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown time' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderJevLogs() {
  if (!dom.jevLogs || !dom.jevLogCount) return;
  dom.jevLogCount.textContent = jevLogs.length;
  if (jevLogs.length === 0) {
    dom.jevLogs.innerHTML = '<li class="jev-log-empty">No Jev calls yet.</li>';
    return;
  }

  dom.jevLogs.innerHTML = [...jevLogs].reverse().map((trace) => {
    const result = trace.result || {};
    const state = trace.request?.state?.current_state || {};
    const actions = Array.isArray(result.actions) ? result.actions.map((action) => action === 'flap' ? 'F' : 'W').join(' ') : '';
    const status = trace.ok ? 'Success' : 'Failed';
    const summary = trace.ok ? `Jev chose ${actions || 'an action plan'}` : trace.error || 'Request failed';
    const confidence = result.confidence === null || result.confidence === undefined ? '' : ` · ${Math.round(result.confidence * 100)}% confidence`;
    return `<li class="jev-log-entry ${trace.ok ? '' : 'is-error'}">
      <div class="jev-log-summary">
        <div><strong>${escapeHtml(summary)}</strong><span>${escapeHtml(status)} · ${escapeHtml(formatTraceTime(trace.at))}</span></div>
        <span class="jev-log-latency">${escapeHtml(trace.duration_ms ?? '-')} ms</span>
      </div>
      <p class="jev-log-context">Bird ${escapeHtml(state.bird_y ?? '-')} px · Pipe ${escapeHtml(state.pipe_distance ?? '-')} px away${escapeHtml(confidence)}</p>
      <details>
        <summary>See request and response</summary>
        <div class="jev-log-detail">
          <div><span>Sent to Jev</span><pre>${prettyJson(trace.request || {})}</pre></div>
          <div><span>Jev response</span><pre>${prettyJson(trace.response || { error: trace.error })}</pre></div>
        </div>
      </details>
    </li>`;
  }).join('');
}

function addJevLog(trace) {
  if (!trace) return;
  jevLogs = [...jevLogs, trace].slice(-50);
  renderJevLogs();
}

async function loadJevLogs() {
  try {
    const response = await fetch('/api/jev/logs');
    const payload = await response.json();
    if (response.ok && Array.isArray(payload.logs)) {
      jevLogs = payload.logs;
      renderJevLogs();
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

function getProjectedState(seconds, world = gameState) {
  const current = getGameSnapshot(world);
  const pipe = getNextPipeFor(world);
  const projectedY = world.bird.y + world.bird.velocity * seconds + 0.5 * GRAVITY * seconds ** 2;
  const projectedVelocity = world.bird.velocity + GRAVITY * seconds;
  const projectedPipeX = pipe ? pipe.x - PIPE_SPEED * seconds : null;
  const inPipeX = pipe && BIRD_X + COLLISION_RADIUS > projectedPipeX && BIRD_X - COLLISION_RADIUS < projectedPipeX + PIPE_WIDTH;
  const hitsPipe = inPipeX && (projectedY - COLLISION_RADIUS < pipe.gapTop || projectedY + COLLISION_RADIUS > pipe.gapBottom);
  const crash = hitsPipe ? (projectedY < pipe.gapTop ? 'upper_pipe' : 'lower_pipe') : projectedY - COLLISION_RADIUS < 0 ? 'ceiling' : projectedY + COLLISION_RADIUS > PLAY_BOTTOM ? 'ground' : null;

  return {
    after_ms: Math.round(seconds * 1000),
    bird_y: Math.round(projectedY),
    bird_velocity: Math.round(projectedVelocity),
    pipe_id: current.pipe_id,
    pipe_distance: projectedPipeX === null ? null : Math.max(0, Math.round(projectedPipeX - BIRD_X)),
    gap_top: current.gap_top,
    gap_bottom: current.gap_bottom,
    gap_offset: pipe ? Math.round(projectedY - (pipe.gapTop + pipe.gapBottom) / 2) : 0,
    predicted_crash: crash,
  };
}

function cloneWorld(world = gameState) {
  return {
    score: world.score,
    bird: { ...world.bird },
    pipes: world.pipes.map((pipe) => ({ ...pipe })),
    flash: world.flash,
  };
}

function simulateActions(world, actions, initialDelay = 0) {
  const simulated = cloneWorld(world);
  let collision = null;

  if (initialDelay > 0) {
    collision = advanceWorld(simulated, initialDelay).collision;
  }

  for (const action of actions) {
    if (collision) break;
    if (action === 'flap') simulated.bird.velocity = FLAP_VELOCITY;
    collision = advanceWorld(simulated, AI_STEP_SECONDS).collision;
  }

  return { world: simulated, collision };
}

function getPlanningWorld() {
  const { actionQueue, timeToNextAction } = gameState.ai;
  return simulateActions(gameState, actionQueue, actionQueue.length > 0 ? timeToNextAction : 0).world;
}

function createActionSequences() {
  const sequences = [];

  function build(actions) {
    if (actions.length === AI_PLAN_STEPS) {
      sequences.push(actions);
      return;
    }

    build([...actions, 'wait']);
    const flapCount = actions.filter((action) => action === 'flap').length;
    if (actions.at(-1) !== 'flap' && flapCount < 3) {
      build([...actions, 'flap']);
    }
  }

  build([]);
  return sequences;
}

function getSequenceOptions(planningWorld) {
  const startingScore = planningWorld.score;
  const evaluated = actionSequences.map((actions) => {
    const result = simulateActions(planningWorld, actions);
    const snapshot = getGameSnapshot(result.world);
    const id = actions.map((action) => action === 'flap' ? 'f' : 'w').join('');
    const outcome = result.collision ? `collision ${result.collision}` : 'survives';
    return {
      id,
      actions,
      collision: result.collision,
      description: `${actions.join(', ')}. ${outcome}; passes ${snapshot.score - startingScore} pipes; ends at y ${snapshot.bird_y}, velocity ${snapshot.bird_velocity}, gap offset ${snapshot.gap_offset}.`,
    };
  });
  const safe = evaluated.filter((sequence) => !sequence.collision);
  return safe.length > 0 ? safe : evaluated;
}

function getAIState(world = gameState) {
  return {
    current_state: getGameSnapshot(world),
    physics: {
      gravity: GRAVITY,
      flap_velocity: FLAP_VELOCITY,
      pipe_speed: PIPE_SPEED,
      step_ms: AI_STEP_MS,
      positive_y_direction: 'down',
    },
    projected_states: AI_PROJECTION_TIMES.map((seconds) => getProjectedState(seconds, world)),
    move_history: physicsHistory.getAll(),
  };
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

function getPlanRequestThreshold() {
  const latency = gameState.ai.latency ?? 700;
  return Math.min(AI_PLAN_STEPS - 1, Math.ceil(latency / AI_STEP_MS) + 1);
}

function advanceAIPhysics(delta) {
  let remaining = delta;

  while (remaining > 0 && gameState.phase === 'running') {
    if (gameState.ai.actionQueue.length === 0) return;

    if (gameState.ai.timeToNextAction <= 0) {
      const action = gameState.ai.actionQueue.shift();
      applyAIDecision(action, gameState.ai.latency);
      gameState.ai.timeToNextAction = AI_STEP_SECONDS;

      if (gameState.ai.actionQueue.length <= getPlanRequestThreshold() && !gameState.ai.requestInFlight) {
        requestAIDecision();
      }
    }

    const step = Math.min(remaining, gameState.ai.timeToNextAction);
    const result = advancePhysics(step);
    gameState.ai.timeToNextAction -= result.elapsedSeconds;
    remaining -= result.elapsedSeconds;
    if (result.collision) return;
  }
}

async function requestAIDecision() {
  if (gameState.mode !== 'physics' || gameState.phase !== 'running' || gameState.ai.requestInFlight) return;

  const runToken = gameState.ai.runToken;
  const startedAt = performance.now();
  const planningWorld = getPlanningWorld();
  const sequences = getSequenceOptions(planningWorld);
  const requestBody = {
    state: getAIState(planningWorld),
    sequences: sequences.map(({ id, actions, description }) => ({ id, actions, description })),
  };
  gameState.ai.requestInFlight = true;
  gameState.ai.error = null;
  updateUI();

  let traceRecorded = false;
  try {
    const response = await fetch('/api/jev/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const payload = await response.json();
    addJevLog(payload.trace || makeClientTrace(requestBody, payload, response.ok, payload.error, performance.now() - startedAt));
    traceRecorded = true;
    if (!response.ok) throw new Error(payload.error || 'Jev could not make a decision.');
    if (gameState.ai.runToken !== runToken || gameState.phase !== 'running' || gameState.mode !== 'physics') return;
    if (!Array.isArray(payload.actions) || payload.actions.length !== AI_PLAN_STEPS || payload.actions.some((action) => !['flap', 'wait'].includes(action))) {
      throw new Error('Jev returned an invalid action plan.');
    }

    gameState.ai.requestInFlight = false;
    gameState.ai.confidence = payload.confidence;
    const requestLatency = performance.now() - startedAt;
    gameState.ai.latency = Math.round(requestLatency);
    gameState.ai.actionQueue.push(...payload.actions);
  } catch (error) {
    if (!traceRecorded) addJevLog(makeClientTrace(requestBody, null, false, error.message, performance.now() - startedAt));
    if (gameState.ai.runToken === runToken && gameState.phase === 'running') {
      gameState.ai.requestInFlight = false;
      pauseForAIError(error.message);
    }
  }
  updateUI();
}

function updateUI() {
  if (!gameState) return;
  const pipe = getNextPipe();
  const offset = pipe ? gameState.bird.y - (pipe.gapTop + pipe.gapBottom) / 2 : 0;
  dom.score.textContent = gameState.score;
  dom.seedValue.textContent = SEED;
  dom.birdHeight.textContent = `${Math.round(gameState.bird.y)} px`;
  dom.birdSpeed.textContent = `${gameState.bird.velocity >= 0 ? '+' : ''}${Math.round(gameState.bird.velocity)} px/s`;
  dom.pipeDistance.textContent = pipe ? `${Math.max(0, Math.round(pipe.x - BIRD_X))} px` : '-';
  dom.gapOffset.textContent = `${offset >= 0 ? '+' : ''}${Math.round(offset)} px`;

  if (gameState.mode === 'physics') {
    dom.actionLabel.textContent = 'Last action';
    dom.nextAction.textContent = gameState.ai.actionQueue.length === 0 && gameState.ai.requestInFlight ? 'Planning' : gameState.ai.lastAction === 'flap' ? 'Flap' : 'Wait';
    dom.aiConfidence.textContent = gameState.ai.confidence === null ? '-' : `${Math.round(gameState.ai.confidence * 100)}%`;
    dom.aiLatency.textContent = gameState.ai.latency === null ? '-' : `${gameState.ai.latency} ms`;
    dom.historyCount.textContent = `${physicsHistory.size} / 100`;
    dom.inspectorNote.textContent = gameState.ai.error || `Jev has ${gameState.ai.actionQueue.length} buffered actions ready.`;
  } else {
    dom.actionLabel.textContent = 'Next action';
    dom.nextAction.textContent = gameState.phase === 'running' ? 'Your call' : 'Waiting';
    dom.aiConfidence.textContent = '-';
    dom.aiLatency.textContent = '-';
    dom.historyCount.textContent = '0 / 100';
    dom.inspectorNote.textContent = gameState.phase === 'running' ? 'The pipe pattern is deterministic. Find a rhythm that works.' : 'Play a run to see the game state update here.';
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
dom.resetButton.addEventListener('click', () => resetGame());
dom.clearExperience.addEventListener('click', () => {
  physicsHistory.clear();
  resetGame('physics');
});
dom.clearJevLogs.addEventListener('click', async () => {
  try {
    await fetch('/api/jev/logs', { method: 'DELETE' });
  } catch {
    // Clearing the visible session is still useful if the local endpoint is unavailable.
  }
  jevLogs = [];
  renderJevLogs();
});
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
cancelAnimationFrame(animationFrame);
animationFrame = requestAnimationFrame(loop);

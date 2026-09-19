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
const AI_PROJECTION_TIMES = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
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
  resetButton: document.querySelector('#reset-button'),
  clearExperience: document.querySelector('#clear-experience'),
};

let gameState;
let lastFrame = performance.now();
let animationFrame;
let aiRunToken = 0;

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
    nextRequestTimer: null,
    lastAction: 'wait',
    confidence: null,
    latency: null,
    error: null,
    runId: null,
    runToken: ++aiRunToken,
  };
}

function resetGame(mode = gameState?.mode || 'human') {
  if (gameState?.ai?.nextRequestTimer !== null) {
    clearTimeout(gameState.ai.nextRequestTimer);
  }
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

function getNextPipe() {
  return gameState.pipes.find((pipe) => pipe.x + PIPE_WIDTH >= BIRD_X - BIRD_RADIUS) || gameState.pipes[gameState.pipes.length - 1];
}

function update(delta) {
  if (gameState.phase !== 'running') return;
  if (gameState.mode === 'physics') {
    updateUI();
    return;
  }
  advancePhysics(delta);
  updateUI();
}

function advancePhysics(delta) {
  let elapsed = 0;
  const maxSubstep = 1 / 120;

  while (elapsed < delta && gameState.phase === 'running') {
    const step = Math.min(maxSubstep, delta - elapsed);
    gameState.flash = Math.max(0, gameState.flash - step);
    gameState.bird.velocity += GRAVITY * step;
    gameState.bird.y += gameState.bird.velocity * step;
    gameState.bird.rotation = Math.min(1.35, gameState.bird.rotation + step * 1.9);

    for (const pipe of gameState.pipes) {
      pipe.x -= PIPE_SPEED * step;
      if (!pipe.scored && pipe.x + PIPE_WIDTH < BIRD_X - BIRD_RADIUS) {
        pipe.scored = true;
        gameState.score += 1;
      }
    }

    elapsed += step;
    const collision = getCollisionReason();
    if (collision) {
      endGame(collision);
      return { elapsedSeconds: elapsed, collision };
    }
  }

  return { elapsedSeconds: elapsed, collision: null };
}

function getCollisionReason() {
  const pipe = getNextPipe();
  const birdHitsPipe = pipe && BIRD_X + COLLISION_RADIUS > pipe.x && BIRD_X - COLLISION_RADIUS < pipe.x + PIPE_WIDTH && (gameState.bird.y - COLLISION_RADIUS < pipe.gapTop || gameState.bird.y + COLLISION_RADIUS > pipe.gapBottom);
  if (birdHitsPipe) return gameState.bird.y < pipe.gapTop ? 'upper_pipe' : 'lower_pipe';
  if (gameState.bird.y - COLLISION_RADIUS < 0) return 'ceiling';
  if (gameState.bird.y + COLLISION_RADIUS > PLAY_BOTTOM) return 'ground';
  return null;
}

function endGame(reason = 'unknown') {
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

function scheduleNextAIDecision(delay, runToken) {
  gameState.ai.nextRequestTimer = setTimeout(() => {
    if (gameState.ai.runToken !== runToken || gameState.phase !== 'running' || gameState.mode !== 'physics') return;
    gameState.ai.nextRequestTimer = null;
    requestAIDecision();
  }, delay);
}

function getGameSnapshot() {
  const pipe = getNextPipe();
  const pipeIndex = pipe ? gameState.pipes.indexOf(pipe) : -1;
  const gapCenter = pipe ? (pipe.gapTop + pipe.gapBottom) / 2 : gameState.bird.y;
  return {
    score: gameState.score,
    bird_y: Math.round(gameState.bird.y),
    bird_velocity: Math.round(gameState.bird.velocity),
    pipe_id: pipeIndex,
    pipe_distance: pipe ? Math.max(0, Math.round(pipe.x - BIRD_X)) : null,
    gap_top: pipe ? Math.round(pipe.gapTop) : null,
    gap_bottom: pipe ? Math.round(pipe.gapBottom) : null,
    gap_offset: Math.round(gameState.bird.y - gapCenter),
  };
}

function getProjectedState(seconds) {
  const current = getGameSnapshot();
  const pipe = getNextPipe();
  const projectedY = gameState.bird.y + gameState.bird.velocity * seconds + 0.5 * GRAVITY * seconds ** 2;
  const projectedVelocity = gameState.bird.velocity + GRAVITY * seconds;
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

function getAIState() {
  return {
    current_state: getGameSnapshot(),
    physics: {
      gravity: GRAVITY,
      flap_velocity: FLAP_VELOCITY,
      pipe_speed: PIPE_SPEED,
      step_ms: AI_STEP_MS,
      positive_y_direction: 'down',
    },
    projected_states: AI_PROJECTION_TIMES.map(getProjectedState),
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

function applyAIDecision(action, requestLatency) {
  const before = getGameSnapshot();
  if (action === 'flap') applyFlap();
  gameState.ai.lastAction = action;
  const stepResult = advancePhysics(AI_STEP_SECONDS);
  const after = getGameSnapshot();
  recordAIStep(action, before, after, stepResult, requestLatency);
}

async function requestAIDecision() {
  if (gameState.mode !== 'physics' || gameState.phase !== 'running' || gameState.ai.requestInFlight) return;

  const runToken = gameState.ai.runToken;
  const startedAt = performance.now();
  gameState.ai.requestInFlight = true;
  gameState.ai.error = null;
  updateUI();

  try {
    const response = await fetch('/api/jev/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: getAIState() }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Jev could not make a decision.');
    if (gameState.ai.runToken !== runToken || gameState.phase !== 'running' || gameState.mode !== 'physics') return;
    if (!['flap', 'wait'].includes(payload.action)) throw new Error('Jev returned an invalid action.');

    gameState.ai.requestInFlight = false;
    gameState.ai.confidence = payload.confidence;
    const requestLatency = performance.now() - startedAt;
    gameState.ai.latency = Math.round(requestLatency);
    applyAIDecision(payload.action, gameState.ai.latency);
    if (gameState.phase === 'running') {
      scheduleNextAIDecision(Math.max(0, AI_STEP_MS - requestLatency), runToken);
    }
  } catch (error) {
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
    dom.nextAction.textContent = gameState.ai.requestInFlight ? 'Thinking' : gameState.ai.lastAction === 'flap' ? 'Flap' : 'Wait';
    dom.aiConfidence.textContent = gameState.ai.confidence === null ? '-' : `${Math.round(gameState.ai.confidence * 100)}%`;
    dom.aiLatency.textContent = gameState.ai.latency === null ? '-' : `${gameState.ai.latency} ms`;
    dom.historyCount.textContent = `${physicsHistory.size} / 100`;
    dom.inspectorNote.textContent = gameState.ai.error || 'Jev is choosing one action, then the game advances by 1/7 second.';
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
cancelAnimationFrame(animationFrame);
animationFrame = requestAnimationFrame(loop);

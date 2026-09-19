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
const GRAVITY = 1050;
const FLAP_VELOCITY = -430;

const dom = {
  score: document.querySelector('#score'),
  runStatus: document.querySelector('#run-status'),
  overlay: document.querySelector('#start-overlay'),
  overlayKicker: document.querySelector('#overlay-kicker'),
  overlayTitle: document.querySelector('#overlay-title'),
  overlayCopy: document.querySelector('#overlay-copy'),
  startButton: document.querySelector('#start-button'),
  nextAction: document.querySelector('#next-action'),
  birdHeight: document.querySelector('#bird-height'),
  birdSpeed: document.querySelector('#bird-speed'),
  pipeDistance: document.querySelector('#pipe-distance'),
  gapOffset: document.querySelector('#gap-offset'),
  inspectorNote: document.querySelector('#inspector-note p'),
  resetButton: document.querySelector('#reset-button'),
};

let gameState;
let lastFrame = performance.now();
let animationFrame;

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

function resetGame() {
  gameState = {
    phase: 'ready',
    score: 0,
    bird: { y: HEIGHT * 0.45, velocity: 0, rotation: 0 },
    pipes: createPipes(),
    flash: 0,
  };
  updateUI();
}

function startGame() {
  if (gameState.phase === 'running') return;
  if (gameState.phase === 'gameover') resetGame();
  gameState.phase = 'running';
  dom.overlay.classList.add('hidden');
  dom.runStatus.textContent = 'Flying';
  updateUI();
}

function flap() {
  if (gameState.phase !== 'running') {
    startGame();
  }
  if (gameState.phase === 'running') {
    gameState.bird.velocity = FLAP_VELOCITY;
    gameState.bird.rotation = -0.35;
    gameState.flash = 0.1;
  }
}

function getNextPipe() {
  return gameState.pipes.find((pipe) => pipe.x + PIPE_WIDTH >= BIRD_X - BIRD_RADIUS) || gameState.pipes[gameState.pipes.length - 1];
}

function update(delta) {
  if (gameState.phase !== 'running') return;
  gameState.flash = Math.max(0, gameState.flash - delta);
  gameState.bird.velocity += GRAVITY * delta;
  gameState.bird.y += gameState.bird.velocity * delta;
  gameState.bird.rotation = Math.min(1.35, gameState.bird.rotation + delta * 1.9);

  for (const pipe of gameState.pipes) {
    pipe.x -= PIPE_SPEED * delta;
    if (!pipe.scored && pipe.x + PIPE_WIDTH < BIRD_X - BIRD_RADIUS) {
      pipe.scored = true;
      gameState.score += 1;
    }
  }

  const pipe = getNextPipe();
  const birdHitsPipe = pipe && BIRD_X + COLLISION_RADIUS > pipe.x && BIRD_X - COLLISION_RADIUS < pipe.x + PIPE_WIDTH && (gameState.bird.y - COLLISION_RADIUS < pipe.gapTop || gameState.bird.y + COLLISION_RADIUS > pipe.gapBottom);
  const hitsBounds = gameState.bird.y - COLLISION_RADIUS < 0 || gameState.bird.y + COLLISION_RADIUS > PLAY_BOTTOM;
  if (birdHitsPipe || hitsBounds) endGame();
  updateUI();
}

function endGame() {
  gameState.phase = 'gameover';
  dom.runStatus.textContent = 'Crashed';
  dom.overlayKicker.textContent = 'Human mode';
  dom.overlayTitle.textContent = `Run ended at ${gameState.score}`;
  dom.overlayCopy.textContent = 'Same seed, same pipes. Try a different rhythm.';
  dom.startButton.innerHTML = 'Try again <span>↗</span>';
  dom.overlay.classList.remove('hidden');
  updateUI();
}

function updateUI() {
  if (!gameState) return;
  const pipe = getNextPipe();
  const offset = pipe ? gameState.bird.y - (pipe.gapTop + pipe.gapBottom) / 2 : 0;
  dom.score.textContent = gameState.score;
  dom.birdHeight.textContent = `${Math.round(gameState.bird.y)} px`;
  dom.birdSpeed.textContent = `${gameState.bird.velocity >= 0 ? '+' : ''}${Math.round(gameState.bird.velocity)} px/s`;
  dom.pipeDistance.textContent = pipe ? `${Math.max(0, Math.round(pipe.x - BIRD_X))} px` : '-';
  dom.gapOffset.textContent = `${offset >= 0 ? '+' : ''}${Math.round(offset)} px`;

  dom.nextAction.textContent = gameState.phase === 'running' ? 'Your call' : 'Waiting';
  dom.inspectorNote.textContent = gameState.phase === 'running' ? 'The pipe pattern is deterministic. Find a rhythm that works.' : 'Play a run to see the game state update here.';
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

function drawBird() {
  const { y, rotation } = gameState.bird;
  ctx.save();
  ctx.translate(BIRD_X, y);
  ctx.rotate(rotation);
  ctx.fillStyle = '#ffd36c';
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ef9a46';
  ctx.beginPath();
  ctx.ellipse(-5, 7, 11, 5, -0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f5a344';
  ctx.beginPath();
  ctx.moveTo(11, -2); ctx.lineTo(27, 2); ctx.lineTo(11, 7); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(7, -7, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#17283b';
  ctx.beginPath(); ctx.arc(8, -7, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function draw() {
  drawBackground();
  for (const pipe of gameState.pipes) drawPipe(pipe);
  drawGround();
  drawBird();
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
dom.resetButton.addEventListener('click', () => {
  resetGame();
  dom.overlayKicker.textContent = 'Human mode';
  dom.overlayTitle.textContent = 'Ready to fly?';
  dom.overlayCopy.textContent = 'Tap, click, or press Space to flap through the gaps.';
  dom.startButton.innerHTML = 'Start run <span>↗</span>';
  dom.overlay.classList.remove('hidden');
});
canvas.addEventListener('pointerdown', flap);
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    flap();
  }
});

resetGame();
cancelAnimationFrame(animationFrame);
animationFrame = requestAnimationFrame(loop);

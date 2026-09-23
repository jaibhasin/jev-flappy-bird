import assert from 'node:assert/strict';
import test from 'node:test';

function createElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    click: () => listeners.get('click')?.(),
    innerHTML: '',
    textContent: '',
  };
}

test('Jev waits for its first answer before the bird starts falling', async () => {
  let now = 0;
  let nextFrame;
  let intervalTick;
  let stream;
  const requests = [];
  const selectors = [
    '#score', '#seed-value', '#run-status', '#start-overlay', '#overlay-kicker',
    '#overlay-title', '#overlay-copy', '#start-button', '#human-mode',
    '#physics-mode', '#control-hint', '#jev-question', '#jev-state',
    '#jev-choices', '#jev-action', '#jev-probabilities',
  ];
  const elements = new Map(selectors.map((selector) => [selector, createElement()]));
  const canvas = createElement();
  canvas.width = 540;
  canvas.height = 720;
  canvas.getContext = () => ({
    arc() {}, beginPath() {}, closePath() {}, ellipse() {}, fill() {},
    fillRect() {}, lineTo() {}, moveTo() {}, restore() {}, rotate() {},
    save() {}, stroke() {}, translate() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  });
  elements.set('#game', canvas);

  globalThis.performance = { now: () => now };
  globalThis.document = { body: createElement(), querySelector: (selector) => elements.get(selector) ?? null };
  globalThis.window = { addEventListener() {} };
  globalThis.EventSource = class {
    constructor() { stream = this; }
  };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/jev/logs') return { ok: true, json: async () => ({ logs: [] }) };
    requests.push(JSON.parse(options.body));
    return { status: 202 };
  };
  globalThis.requestAnimationFrame = (callback) => { nextFrame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setInterval = (callback) => { intervalTick = callback; return 1; };
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => {};

  const { getProjectedState } = await import('./game.js');
  elements.get('#physics-mode').click();
  elements.get('#start-button').click();
  assert.equal(elements.get('#run-status').textContent, 'Waiting for Jev');

  stream.onopen();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].state.after_ms, 0);

  now = 1200;
  nextFrame(now);
  assert.equal(elements.get('#run-status').textContent, 'Waiting for Jev');
  assert.equal(requests.length, 1);

  stream.onmessage({ data: JSON.stringify({
    rid: requests[0].rid,
    status: 200,
    body: {
      action: 'plan',
      plan_id: requests[0].plans[0].id,
      trajectory_version: 0,
      confidence: 1,
    },
  }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('#run-status').textContent, 'Playing');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].trajectory_version, 1);
  assert.ok(requests[1].state.decision_at_game_ms >= requests[1].state.committed_plan_end_ms + 600);
  assert.ok(requests[1].state.candidate_plans.length > 0);

  now = 1234;
  nextFrame(now);
  intervalTick();
  assert.equal(requests.length, 2);

  const world = {
    bird: { y: 300, velocity: 0 },
    pipes: [
      { x: 100, gapTop: 100, gapBottom: 278 },
      { x: 355, gapTop: 260, gapBottom: 438 },
    ],
  };
  assert.equal(getProjectedState(0, world).pipe_id, 0);
  const projected = getProjectedState(0.6, world);
  assert.equal(projected.pipe_id, 1);
  assert.equal(projected.gap_top, 260);
  assert.equal(projected.pipe_distance, 126);
  assert.equal(projected.clearance_above, 201);
  assert.equal(projected.position, 'below the gap');
});

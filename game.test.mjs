import assert from 'node:assert/strict';
import test from 'node:test';

function createElement() {
  const listeners = new Map();
  const classes = new Set();
  return {
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name => classes.delete(name))),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    click: () => listeners.get('click')?.(),
    pointerdown: () => listeners.get('pointerdown')?.(),
    replaceChildren() {},
    append() {},
    parentElement: { setAttribute() {}, removeAttribute() {} },
    style: {},
    innerHTML: '',
    textContent: '',
  };
}

for (const runner of ['jev', 'openai']) test(`${runner} keeps the same slow physics running with overlapping decisions`, async () => {
  let now = 0;
  let nextFrame;
  let intervalTick;
  let stream;
  const requests = [];
  const urls = [];
  const selectors = [
    '#score', '#run-status', '#start-overlay', '#overlay-kicker', '#overlay-title',
    '#overlay-copy', '#start-button', '#human-mode', '#physics-mode', '#control-hint',
    '#live-action', '#wait-confidence', '#wait-confidence-fill', '#flap-confidence',
    '#flap-confidence-fill', '#stat-latency', '#stat-decisions', '#jev-action', '#jev-question', '#jev-state',
    '#jev-choices', '#decision-history', '#decision-counts',
  ];
  const elements = new Map(selectors.map((selector) => [selector, createElement()]));
  const canvas = createElement();
  canvas.width = 540;
  canvas.height = 720;
  canvas.getContext = () => ({
    arc() {}, beginPath() {}, closePath() {}, ellipse() {}, fill() {}, fillRect() {},
    lineTo() {}, moveTo() {}, restore() {}, rotate() {}, save() {}, stroke() {}, translate() {},
    createLinearGradient: () => ({ addColorStop() {} }),
  });
  elements.set('#game', canvas);
  globalThis.location = { search: `?runner=${runner}`, origin: 'http://localhost', href: 'http://localhost/' };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {
    randomUUID: (() => { let id = 0; return () => `id-${++id}`; })(),
    getRandomValues: (values) => { values[0] = 123; return values; },
  } });
  globalThis.performance = { now: () => now };
  globalThis.document = { body: createElement(), querySelector: (selector) => elements.get(selector) ?? null,
    getElementById: (id) => elements.get(`#${id}`) ?? createElement(), createElement: () => createElement() };
  globalThis.window = { addEventListener() {}, postMessage() {} };
  globalThis.window.parent = globalThis.window;
  globalThis.EventSource = class { constructor() { stream = this; } };
  globalThis.fetch = async (url, options) => {
    if (url === '/api/jev/logs') return { ok: true, json: async () => ({ logs: [] }) };
    if (url === '/api/diagnostics') return { status: 202 };
    urls.push(url);
    requests.push(JSON.parse(options.body));
    return { status: 202 };
  };
  globalThis.requestAnimationFrame = (callback) => { nextFrame = callback; return 1; };
  globalThis.setInterval = (callback) => { intervalTick = callback; return 1; };
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 1;
  globalThis.clearTimeout = () => {};

  await import(`./game.js?test=${runner}-${Date.now()}`);
  stream.onopen();
  elements.get('#physics-mode').click();
  elements.get('#start-button').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(urls[0], `/api/${runner}/action`);
  assert.equal(requests[0].state.prediction_lead_ms, 0);
  assert.equal(requests[0].state.game_speed, 0.3);
  assert.equal(requests[0].plan, undefined);

  now = 300;
  nextFrame(now);
  assert.equal(requests.length, 1, 'takeoff waits for the first model decision');
  assert.equal(elements.get('#run-status').textContent, 'Connecting');

  stream.onmessage({ data: JSON.stringify({ rid: requests[0].rid, status: 200,
    body: { action: 'flap', sequence: 0, probabilities: { flap: 0.8 } } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2, 'the next request begins immediately after takeoff');
  assert.ok(requests[1].state.prediction_lead_ms > 0);
  intervalTick();
  assert.equal(requests.length, 3, 'model requests overlap');
  for (let frame = 0; frame < 8; frame += 1) { now += 50; nextFrame(now); }
  assert.equal(requests.length, 3, 'physics does not wait for in-flight answers');
  intervalTick();
  assert.ok(Math.abs(requests.at(-1).state.observed_game_ms - 120) <= 9,
    '400 real milliseconds advance 120 game milliseconds, within one physics step');
  now += 200;
  nextFrame(now);
  intervalTick();
  assert.ok(Math.abs(requests.at(-1).state.observed_game_ms - 180) <= 9,
    'a delayed frame advances by the full time at 30% speed');

  stream.onmessage({ data: JSON.stringify({ rid: requests[1].rid, status: 200,
    body: { action: 'flap', sequence: 1 } }) });
  await new Promise((resolve) => setImmediate(resolve));
  stream.onmessage({ data: JSON.stringify({ rid: requests[2].rid, status: 200,
    body: { action: 'wait', sequence: 2 } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.get('#decision-counts').textContent, /1 superseded/);
  assert.equal(elements.get('#jev-action').textContent, 'WAIT · superseded');
  assert.equal(elements.get('#run-status').textContent, 'Playing');
  for (let frame = 0; frame < 160 && elements.get('#run-status').textContent === 'Playing'; frame += 1) {
    now += 50;
    nextFrame(now);
  }
  assert.equal(elements.get('#run-status').textContent, 'Game over', 'without further model flaps, the bird falls');
});

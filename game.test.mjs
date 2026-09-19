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

test('the game initializes and the start button begins a run', async () => {
  let nextFrame;
  const requests = [];
  const selectors = [
    '#score', '#seed-value', '#run-status', '#start-overlay', '#overlay-kicker',
    '#overlay-title', '#overlay-copy', '#start-button', '#human-mode',
    '#physics-mode', '#control-hint', '#inspector-title', '#action-label',
    '#next-action', '#bird-height', '#bird-speed', '#pipe-distance',
    '#gap-offset', '#ai-confidence', '#ai-latency', '#history-count',
    '#reset-button', '#clear-experience', '#jev-log-count', '#jev-logs', '#clear-jev-logs',
  ];
  const elements = new Map(selectors.map((selector) => [selector, createElement()]));
  const inspectorNote = createElement();
  elements.set('#inspector-note p', inspectorNote);

  const canvas = createElement();
  canvas.width = 540;
  canvas.height = 720;
  canvas.getContext = () => ({
    arc() {},
    beginPath() {},
    closePath() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    ellipse() {},
    fill() {},
    fillRect() {},
    lineTo() {},
    moveTo() {},
    restore() {},
    rotate() {},
    save() {},
    stroke() {},
    translate() {},
  });
  elements.set('#game', canvas);

  globalThis.document = {
    body: createElement(),
    querySelector: (selector) => elements.get(selector) ?? null,
  };
  globalThis.window = { addEventListener() {} };
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return {
      ok: true,
      json: async () => ({
        actions: Array(12).fill('wait'),
        confidence: 0.8,
      }),
    };
  };
  globalThis.requestAnimationFrame = (callback) => {
    nextFrame = callback;
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};

  await import('./game.js');

  assert.equal(elements.get('#run-status').textContent, 'Ready');
  assert.equal(elements.get('#bird-height').textContent, '324 px');

  elements.get('#start-button').click();

  assert.equal(elements.get('#run-status').textContent, 'Flying');
  assert.equal(elements.get('#start-overlay').classList.contains('hidden'), true);

  elements.get('#physics-mode').click();
  elements.get('#start-button').click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests[0].sequences.length > 1, true);
  assert.equal(requests[0].sequences.every((sequence) => sequence.actions.length === 12), true);

  const initialPhysicsHeight = elements.get('#bird-height').textContent;
  nextFrame(performance.now() + 100);

  assert.notEqual(elements.get('#bird-height').textContent, initialPhysicsHeight);
});

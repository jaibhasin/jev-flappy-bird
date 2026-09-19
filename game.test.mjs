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
  const selectors = [
    '#score', '#seed-value', '#run-status', '#start-overlay', '#overlay-kicker',
    '#overlay-title', '#overlay-copy', '#start-button', '#human-mode',
    '#physics-mode', '#control-hint', '#inspector-title', '#action-label',
    '#next-action', '#bird-height', '#bird-speed', '#pipe-distance',
    '#gap-offset', '#ai-confidence', '#ai-latency', '#history-count',
    '#reset-button', '#clear-experience',
  ];
  const elements = new Map(selectors.map((selector) => [selector, createElement()]));
  const inspectorNote = createElement();
  elements.set('#inspector-note p', inspectorNote);

  const canvas = createElement();
  canvas.width = 540;
  canvas.height = 720;
  canvas.getContext = () => ({});
  elements.set('#game', canvas);

  globalThis.document = {
    body: createElement(),
    querySelector: (selector) => elements.get(selector) ?? null,
  };
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  await import('./game.js');

  assert.equal(elements.get('#run-status').textContent, 'Ready');
  assert.equal(elements.get('#bird-height').textContent, '324 px');

  elements.get('#start-button').click();

  assert.equal(elements.get('#run-status').textContent, 'Flying');
  assert.equal(elements.get('#start-overlay').classList.contains('hidden'), true);
});

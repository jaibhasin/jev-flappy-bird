# Flappy Bird + Jev 🐦 - Let Jev take the next flap.

> A tiny browser game where you can fly yourself or hand the controls to Jev.

[![Human mode](https://img.shields.io/badge/play-Human%20mode-32c7a5)](#pick-your-pilot)
[![Jev mode](https://img.shields.io/badge/play-Jev%20mode-6957e8)](#how-jev-plays)
[![Canvas](https://img.shields.io/badge/canvas-540%C3%97720-4c91e8)](#game-physics)
[![Node.js](https://img.shields.io/badge/server-Node.js-43853d)](#run)

## Run

```bash
cp .env.example .env
# Add your TypeSafe API key to .env
npm start
```

Open <http://localhost:4173>.

Run `npm run check` for syntax checks and game logic tests.

## Pick your pilot

- **Human mode:** Fly with Space, Up Arrow, click, or tap.
- **With physics mode:** Jev picks a sequence of `flap` and `wait` actions while the game keeps moving at normal speed.

## How Jev plays

The server sends Jev the current planning state, physics values, projected positions, possible sequence outcomes, and the latest 100 moves.

Jev returns one typed sequence of twelve `flap` or `wait` actions.
The game applies one buffered action every `1/7` second through its normal physics.
The API key stays on the server in `server.mjs`.

## Game physics

- Canvas: `540 x 720` pixels.
- Gravity: `950 px/s²`.
- Flap velocity: `-330 px/s`.
- Pipe speed: `178 px/s`.
- Pipe gap: `178 px`.
- Pipe pattern: deterministic while `SEED` is fixed.

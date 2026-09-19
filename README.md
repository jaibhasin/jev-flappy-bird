# Flappy Bird + Jev

A small browser Flappy Bird game with Human mode and With physics mode.

## Run

```bash
cp .env.example .env
# Add your TypeSafe API key to .env
npm start
```

Open <http://localhost:4173>.

Run `npm run check` for syntax checks.

## Game physics

- Canvas: `540 x 720` pixels.
- Gravity: `950 px/s²`.
- Flap velocity: `-330 px/s`.
- Pipe speed: `178 px/s`.
- Pipe gap: `178 px`.
- Pipe pattern: deterministic while `SEED` is fixed.

## Controls

Human mode accepts Space, Up Arrow, click, and tap.

With physics mode lets Jev choose `flap` or `wait`.
Jev selects a buffered twelve-step action sequence so the game can keep moving at normal speed while the next sequence is prepared.

## Jev input

The server sends Jev the projected planning state, physics values, future positions, candidate sequence outcomes, and the latest 100 moves.

Jev returns one typed sequence containing twelve `flap` or `wait` actions.

The game applies one buffered action every `1/7` second through the normal game physics.

The API key stays server-side in `server.mjs`.

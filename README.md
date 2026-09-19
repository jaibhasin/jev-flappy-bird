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
The game pauses while waiting for the answer, then advances exactly `1/7` second.

## Jev input

The server sends Jev the current bird height, vertical velocity, next-pipe distance, gap boundaries, gap offset, physics values, projected states for the next 500 ms, and the latest 100 moves.

Jev returns one typed action: `flap` or `wait`.

The game asks Jev at most seven times per second and applies the returned action through the normal game physics.

The API key stays server-side in `server.mjs`.

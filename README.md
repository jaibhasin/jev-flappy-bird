# Flappy Bird model race 🐦

Run two independent games side by side: Jev and GPT-6 Luna through the OpenAI API.
Both games use the same seeded pipes, physics, and candidate-plan generator.

## Run

```bash
cp .env.example .env
```

Add your TypeSafe and OpenAI API keys to `.env`, then run:

```bash
npm start
```

Open <http://localhost:4173> and select **Start both games**.

Each game runs in its own frame, so its score, state, and model requests are independent.
The API keys stay on the server.

## How the models play

The game simulates candidate flap schedules using its fixed physics.
Each model receives the same projected state and up to 32 safe schedules for a 6.4-second game-time window.
Jev selects a schedule through TypeSafe, and GPT-6 Luna selects one through the OpenAI Chat Completions API.
The game applies the selected flaps and requests another schedule for the next window.

Both games keep moving at 120 physics steps per second while waiting for the model.
If a model fails to answer, the game uses the remaining approved schedule and does not create local fallback flaps.

## Game physics

- Canvas: `540 x 720` pixels.
- Gravity: `950 px/s²`.
- Flap velocity: `-330 px/s`.
- Pipe speed: `178 px/s`.
- Pipe gap: `178 px`.
- Pipe pattern: deterministic with `SEED = 1337`.

Run `npm run check` for syntax checks and game logic tests.

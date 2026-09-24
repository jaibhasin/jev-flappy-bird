# Flappy Bird model race 🐦

Run two independent games side by side: Jev and GPT-6 Luna through the OpenAI API.
Both games use a fresh shared course and identical physics.
Each model gets the current state and chooses one immediate action: flap or wait.

## Run

```bash
cp .env.example .env
```

Add your TypeSafe and OpenAI API keys to `.env`, then run:

```bash
npm start
```

Open <http://localhost:4173> and select **Start the matchup**.

Each game runs in its own frame, so its score, state, and model requests are independent.
The API keys stay on the server.

## How the models play

Each model receives a projected bird position and velocity, the next pipe, and its gap clearances.
It returns one `flap` or `wait` action through TypeSafe or the OpenAI API.
No candidate plans, scheduled actions, safety overrides, or fallback flaps are used.

Both birds and their pipes run continuously at half real-time speed.
The game asks each model every 50 ms and can have up to 12 decisions in flight per game.
Each question describes the projected scene when its answer is expected to arrive.
A `wait` leaves other pending answers valid, while a `flap` supersedes answers based on the old flight path.
If a model stops answering, its bird keeps falling without a local rescue flap.
The local server delivers answers over an event stream, and both upstream APIs use persistent HTTP/2-capable connections.

Response times, the latest action, in-flight status, and errors remain visible.

Each matchup generates a new random seed and sends it to both games.
The visible course ID identifies that seed.
Both models prepare their first decision before the birds take off together.
They see identical observations initially, then each sees its own bird state as their choices diverge.
The live panels show actual responses, round-trip response times, application status, and error counts.
Identical choices are possible; no artificial variation is added to model actions.

## Game physics

- Canvas: `540 x 720` pixels.
- Gravity: `950 px/s²`.
- Flap velocity: `-330 px/s`.
- Pipe speed: `178 px/s`.
- Pipe gap: `178 px`.
- Pipe pattern: deterministic from a fresh shared seed for each matchup.

The two lanes use the same physics speed, fixed simulation step, and decision cadence.

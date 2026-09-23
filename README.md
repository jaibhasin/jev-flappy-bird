# Flappy Bird model race 🐦

Run two independent games side by side: Jev and GPT-6 Luna through the OpenAI API.
Both games use a fresh shared course, identical physics, and the same direct FLAP/WAIT decision schedule.

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

Each model receives the same instructions and observation format: its bird position and velocity, the next three pipes, and the game physics.
Jev chooses `flap` or `wait` through TypeSafe, and GPT-6 Luna makes the same structured choice through the OpenAI API.
There are no generated flight plans, safety overrides, or automatic fallback flaps.

Both games wait for their first decision, then launch on a shared countdown.
During play, physics runs continuously at 120 steps per second, independently of API responses.
Both controllers ask every 50 ms, with up to twelve requests in flight per player.
The local server immediately acknowledges each request and delivers its answer over an event stream, avoiding the browser's six-connection request queue.
Both upstream APIs use persistent HTTP/2-capable connections.

Observations project the bird and pipes forward by an adaptive estimate of response latency, assuming no intervening flap.
Projection describes the scene only; it never chooses an action or supplies a flap schedule.
Answers arriving early are held until their projected game time while physics continues.
Answers from before an intervening flap, older than an applied decision, or from a previous run cannot control the bird.
Errors produce no input, and the bird continues under gravity.

Before the shared countdown, each model receives two requests to warm its connection; the second supplies its takeoff choice.
After takeoff there are no waits or pauses for either model.
Response times, pending requests, superseded responses, and errors remain visible.
Very high API latency can still exceed the bird's recovery time; no local controller conceals that failure.

The request pipeline follows the approach described in [hosseintoussi/jev-flappy-bird](https://github.com/hosseintoussi/jev-flappy-bird): concurrent decisions, projected observations, and streamed responses.

Each matchup generates a new random seed and sends it to both games.
The visible course ID identifies that seed.
Both models see identical observations initially, then each sees its own bird state as their choices diverge.
The live panels show actual responses, round-trip response times, application status, and error counts.
Identical choices are possible; no artificial variation is added to model actions.

## Game physics

- Canvas: `540 x 720` pixels.
- Gravity: `950 px/s²`.
- Flap velocity: `-330 px/s`.
- Pipe speed: `178 px/s`.
- Pipe gap: `178 px`.
- Pipe pattern: deterministic from a fresh shared seed for each matchup.

The existing game tests target the previous flight-plan controller and need updating for direct control.

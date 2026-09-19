# Jev AI modes plan

## Goal

Build two AI modes: **With physics** and **Trial and error**.
Keep Human mode available.
Compare whether Jev plays better with physics information and whether past experience helps it improve.

Both AI modes use TypeSafe's `Choice` question to select `flap` or `wait`.
Show the returned probabilities and confidence, but do not treat confidence as proof that an action is correct.

## Mode 1: With physics

Give Jev:

- Bird position and vertical speed.
- Pipe positions and opening boundaries.
- Screen boundaries and bird size.
- Gravity, flap strength, and pipe speed.
- Predicted future positions after 100, 200, 300, 400, and 500 ms without another flap.
- The latest 100 moves from this mode, including previous runs.

Ask which action it should take now to stay alive and pass pipes.
Calculate predictions using the same physics as the game, including collisions.
Mark predictions that end in a crash rather than continuing through obstacles.

This tests how well Jev plays when it knows the movement rules and receives predictions.

## Mode 2: Trial and error

Give Jev:

- Bird position and vertical speed.
- Pipe positions and opening boundaries.
- Screen boundaries and bird size.
- The goal: stay alive and pass pipes.
- The available actions: `flap` and `wait`.
- The latest 100 moves from this mode, including previous runs.

Do not provide gravity, flap strength, pipe speed, predicted positions, or calculated action advice.
Explain coordinate directions and units so Jev can read the observations correctly.
Jev must use previous observations and outcomes to discover how the movement behaves.

Ask one question: which action should it take now?

History gives Jev examples to use in its next decision.
It does not update the model itself, and improvement is not guaranteed.

## Shared timing for the first version

Use the same step-by-step game clock in both AI modes.
This keeps network delays from deciding which mode performs better.

1. Pause physics and capture the current state.
2. Send the state and history to Jev.
3. Receive and apply exactly one action.
4. Advance the game by `1 / 7` second, checking collisions throughout.
5. Record the outcome, or end the run immediately if the bird crashes.
6. Repeat from the new state.

This means seven decisions per game second, not necessarily seven requests per real second.
Keep request starts at least `1000 / 7` ms apart and allow only one pending request.
Show “Waiting for Jev” while physics is paused.
Do not accumulate paused time or replay it when a response arrives.
Human mode continues to run normally.

With this timing, With physics uses one “act now” Choice answer.
Its future positions provide guidance, not a sequence of actions to execute.
The earlier idea of selecting among answers for different network delays belongs to the later continuous-play experiment.

## Move history

Keep a separate rolling buffer of 100 moves for each AI mode.
Place these buffers outside the state that resets for each run.
For the first version, keep history for the current page session; reloading starts fresh.

Each completed record contains:

```js
{
  run_id: 3,
  move_id: 17,
  seed: 1337,
  before: {
    bird_y: 310,
    bird_velocity: 120,
    pipe_id: 4,
    pipe_distance: 90,
    gap_top: 250,
    gap_bottom: 428
  },
  action: "flap",
  after: {
    bird_y: 272,
    bird_velocity: -194,
    pipe_id: 4,
    pipe_distance: 65,
    gap_top: 250,
    gap_bottom: 428
  },
  elapsed_game_ms: 143,
  request_latency_ms: 210,
  result: {
    survived: true,
    pipes_passed: 0,
    crash_reason: null
  }
}
```

The numbers above illustrate the format; actual values come from the game.
Include enough pipe geometry to understand each observation, especially when the next pipe changes.

- Start a pending record when an action is applied.
- Complete it after the game step or crash.
- Send completed records as history in the next request.
- Remove the oldest record when adding the 101st.
- Preserve history when “Try again” resets the bird and pipes.
- Switch to the appropriate history when changing modes.
- “Clear experience” resets the selected AI run and its history.
- Invalidate pending responses on reset, mode switch, or clearing experience.
- Do not record failed requests or discarded answers as moves.
- Do not mix Human mode moves into AI history.

Send all available records up to the 100-move limit in a compact format.
Measure request size and token usage with a full buffer before claiming it fits the API limits.
Keep the latest observations separate from history and label run boundaries clearly.
No separate `previous_run` object is needed.

## Outcomes

Record observed results:

- Still alive at the end of the step.
- Number of pipes passed during the step.
- Hit the upper pipe.
- Hit the lower pipe.
- Hit the ground.
- Hit the ceiling.

Record the actual elapsed game time if a crash ends a step early.
Do not label every action before a crash as wrong.
A crash can result from several earlier decisions.

## Request and response handling

The browser sends game observations to our server, which calls Jev.
Keep the API key on the server.
Use a fixed model version during comparisons and record the model version returned.

Use the same basic action question in both modes.
Explain that history contains observations, not guaranteed examples of correct actions.
The main difference between modes is the physics information and predictions supplied.

- Validate request fields and enforce a bounded request size.
- Validate that the answer is `flap` or `wait` and that probability fields are valid.
- Match each answer to its run and request ID before applying it.
- Apply each answer at most once.
- On timeout, API error, or invalid response, stay paused and show a retry option.
- Retrying an API request keeps the same game state and does not add a move.
- Prevent human flaps from changing AI runs.

## Interface

Offer three choices:

- Human.
- AI: With physics.
- AI: Trial and error.

Show the latest applied action, action probabilities, confidence, response time, history count, and score.
Clearly distinguish waiting for an answer from the last action already applied.
Provide “Try again” and “Clear experience” controls with different behavior.

## Compare the modes

Run three tests:

| Test | Physics and predictions | Move history |
| --- | --- | --- |
| With physics | Yes | Latest 100 moves |
| Trial and error | No | Latest 100 moves |
| Trial and error, no history | No | None |

The no-history test is a test setting, not another main UI mode.
It shows whether adding history helps compared with decisions from current observations alone.

Start each test group with empty history and use the same seeds, physics, game timing, model version, and attempt limits.
Use repeated attempts on the fixed seed first, then evaluate unfamiliar seeds.
Keep comparison histories isolated so examples from one test do not leak into another.
Keep attempts at API errors separate from completed gameplay results.
Define a common end condition, such as clearing all generated pipes, to bound successful runs.

Measure:

- Average pipes passed and the range of scores.
- Whether scores improve over successive attempts.
- Performance on unfamiliar pipe patterns.
- Response time and actual requests per real second.
- Input tokens and API errors.

Treat one strong run as an example, not proof of learning.
The initial comparison measures physics information and predictions together; it does not isolate the benefit of each.

## Implementation and commits

1. Separate game physics, rendering, AI control, history, and server integration into small modules.
2. Add the shared step-by-step AI clock and response lifecycle.
3. Add both modes and their separate 100-move histories.
4. Add the two request formats and physics predictions.
5. Add inspector details, retry behavior, and “Clear experience.”
6. Verify the behavior and run the comparison.

Make focused commits after completed, checked stages.
Preserve existing user changes and keep README instructions short.

## Verification

- Human keyboard, click, and tap controls still work.
- AI physics stays paused during delayed requests.
- One accepted answer produces one action and one bounded game step.
- Crashes stop the step immediately and produce the correct outcome.
- Retries preserve history; clearing experience removes it.
- Histories never exceed 100 moves or cross between modes.
- Old responses cannot affect a restarted run.
- Trial and error requests contain no physics constants or predictions.
- Predictions match the game when simulated without additional flaps.
- Full history payloads stay within request and context limits.
- Browser tests cover mode changes, waiting, errors, retries, and mobile layout.

## Later: continuous play

After establishing how the two modes perform, test gameplay that continues during requests.
With physics can ask Choice questions for several projected times and select one valid answer when it arrives.
Trial and error must still receive no supplied future positions.

Measure elapsed game time, reject stale answers, and avoid catch-up request bursts.
Slow responses will reduce opportunities to act and may cause crashes before an answer arrives.
Report these results separately from the step-by-step comparison.

export class MoveHistory {
  constructor(limit = 100) {
    this.limit = limit;
    this.moves = [];
    this.nextRunId = 1;
    this.nextMoveId = 1;
  }

  startRun() {
    return this.nextRunId++;
  }

  add(move, runId) {
    this.moves.push({
      run_id: runId,
      move_id: this.nextMoveId++,
      ...move,
    });
    if (this.moves.length > this.limit) this.moves.shift();
  }

  clear() {
    this.moves = [];
    this.nextMoveId = 1;
  }

  getAll() {
    return this.moves;
  }

  get size() {
    return this.moves.length;
  }
}

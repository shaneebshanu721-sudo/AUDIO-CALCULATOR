// history.js — multi-step Undo. Before every change the app records a snapshot of
// the books; Undo restores the previous snapshot. Settings are not affected.
export class UndoHistory {
  constructor(limit = 40) {
    this.limit = limit;
    this.stack = [];
  }

  record(label, state) {
    this.stack.push({ label, snapshot: JSON.stringify({ books: state.books, pending: state.pending, activeBookId: state.activeBookId }) });
    if (this.stack.length > this.limit) this.stack.shift();
  }

  get canUndo() { return this.stack.length > 0; }
  get nextLabel() { return this.stack.length ? this.stack[this.stack.length - 1].label : ''; }

  /** Restore the most recent snapshot into state. Returns the undone action's label, or null. */
  undo(state) {
    const item = this.stack.pop();
    if (!item) return null;
    const snap = JSON.parse(item.snapshot);
    state.books = snap.books;
    state.pending = snap.pending;
    state.activeBookId = snap.activeBookId;
    return item.label;
  }

  clear() { this.stack = []; }
}

/** Transport identity is independent of tool IDs; replay never becomes a new call. */
export class LiveBuffer {
  constructor(limit = 2000) { this.limit = limit; this.reset(); }
  reset() { this.stream = null; this.seq = 0; this.pending = []; this.overflow = false; }
  accept(raw) {
    const next = raw.streamId || 'legacy';
    const changed = this.stream !== null && this.stream !== next;
    if (changed) this.reset();
    this.stream = next;
    if (Number.isFinite(raw.seq)) {
      if (raw.seq <= this.seq) return { accepted: false, changed };
      this.seq = raw.seq;
    }
    return { accepted: true, changed };
  }
  enqueue(event) {
    if (this.pending.length >= this.limit) { this.overflow = true; return false; }
    this.pending.push(event);
    return true;
  }
  drain() { const batch = this.pending; this.pending = []; return batch; }
}

// Retry only the read-only list presentation, never the incoming instruction.
export class TaskListReply {
  constructor(state, { render, delivered = () => {}, now = Date.now }) {
    Object.assign(this, { state, render, delivered, now });
    this.retryAt = 0;
    this.failures = 0;
  }

  request() {
    this.state.data.tasksReplyPending = true;
    this.state.save();
    return this.retry({ force: true });
  }

  retry({ force = false } = {}) {
    if (this.inFlight) return this.inFlight;
    if (!this.state.data.tasksReplyPending || (!force && this.now() < this.retryAt)) return Promise.resolve();
    this.inFlight = Promise.resolve().then(async () => {
      try {
        // Recompute the live terminal snapshot on every attempt.
        const message = await this.render();
        if (!message?.message_id) throw new Error('会话列表尚未送达 Telegram。');
        this.state.data.tasksReplyPending = false;
        this.state.save();
        this.retryAt = this.failures = 0;
        this.delivered(message);
        return message;
      } catch (error) {
        this.retryAt = this.now() + Math.min(30000, 1000 * 2 ** Math.min(++this.failures, 5));
        throw error;
      } finally { this.inFlight = null; }
    });
    return this.inFlight;
  }
}

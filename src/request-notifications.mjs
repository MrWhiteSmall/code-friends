// Retry presentation of live requests only. This never submits a Codex decision.
export class RequestNotifications {
  constructor(pending, { render, delivered = () => {}, failed = () => {}, logError = () => {}, now = Date.now }) {
    Object.assign(this, { pending, render, delivered, failed, logError, now });
  }

  show(key, { force = false } = {}) {
    const entry = this.pending.entries.get(key);
    if (!entry) return Promise.resolve();
    const index = entry.questionIndex;
    if (entry.notification?.index !== index) {
      entry.notification = { index, delivered: false, failures: 0, retryAt: 0 };
    }
    const delivery = entry.notification;
    if (delivery.inFlight) return delivery.inFlight;
    if (!force && (delivery.delivered || delivery.retryAt > this.now())) return Promise.resolve();
    const current = () => this.pending.entries.get(key) === entry && entry.questionIndex === index;
    delivery.inFlight = Promise.resolve().then(async () => {
      try {
        if (!current()) return;
        const message = await this.render(key, current);
        if (message?.message_id && current()) {
          delivery.delivered = true;
          this.delivered(entry.request, message);
        }
        return message;
      } catch (error) {
        if (current()) {
          delivery.retryAt = this.now() + Math.min(30000, 1000 * 2 ** Math.min(++delivery.failures, 5));
          this.failed(entry.request, error);
        }
        throw error;
      } finally {
        delivery.inFlight = null;
      }
    });
    return delivery.inFlight;
  }

  retry() {
    return Promise.all([...this.pending.entries.keys()].map(key => this.show(key).catch(this.logError)));
  }
}

import crypto from 'node:crypto';

export class PendingGrantStore {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  create(payload) {
    this.cleanup();

    const token = crypto.randomBytes(6).toString('hex');

    this.entries.set(token, {
      ...payload,
      expiresAt: Date.now() + this.ttlMs,
    });

    return token;
  }

  consume(token) {
    this.cleanup();

    const entry = this.entries.get(token);

    if (!entry) {
      return null;
    }

    this.entries.delete(token);
    return entry;
  }

  remove(token) {
    this.entries.delete(token);
  }

  get(token) {
    this.cleanup();
    return this.entries.get(token) ?? null;
  }

  cleanup() {
    const now = Date.now();

    for (const [token, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(token);
      }
    }
  }
}

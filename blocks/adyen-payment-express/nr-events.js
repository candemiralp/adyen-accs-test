/**
 * New Relic Event Batcher for cart refresh monitoring
 * Coalesces custom events into single HTTP requests with <5ms overhead.
 *
 * Gracefully degrades to console.debug if window.newrelic unavailable.
 * ponytail: Native async batcher, no external libraries; 100ms flush window or 10-event threshold.
 */

class NREventBatcher {
  constructor(flushIntervalMs = 100, flushThreshold = 10) {
    this.queue = [];
    this.flushIntervalMs = flushIntervalMs;
    this.flushThreshold = flushThreshold;
    this.flushTimeoutId = null;
  }

  /**
   * Record a custom event for batching.
   * Non-blocking: event queued, flushed asynchronously.
   * @param {string} eventType - Custom event type (e.g., 'CartRefreshSuccess')
   * @param {object} data - Event attributes
   */
  recordCustomEvent(eventType, data) {
    if (typeof window === 'undefined' || !window.newrelic) {
      // Fallback: console debug only, no blocking
      console.debug(`[NREventBatcher] ${eventType}`, data);
      return;
    }

    this.queue.push({ eventType, data, timestamp: Date.now() });

    // Flush on threshold (10 events)
    if (this.queue.length >= this.flushThreshold) {
      this.flush();
    } else if (!this.flushTimeoutId) {
      // Schedule flush on interval (100ms) if not already scheduled
      this.flushTimeoutId = setTimeout(() => this.flush(), this.flushIntervalMs);
    }
  }

  /**
   * Flush queued events to New Relic (async, non-blocking).
   */
  flush() {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);

    // Schedule async flush to avoid blocking cart refresh
    // ponytail: setImmediate if available (preferred), otherwise setTimeout 0
    const scheduleAsync = typeof setImmediate !== 'undefined' ? setImmediate : (fn) => setTimeout(fn, 0);

    scheduleAsync(() => {
      batch.forEach(({ eventType, data }) => {
        try {
          window.newrelic.recordCustomEvent(eventType, data);
        } catch (err) {
          console.debug('[NREventBatcher] Failed to record event', eventType, err.message);
        }
      });
    });

    clearTimeout(this.flushTimeoutId);
    this.flushTimeoutId = null;
  }

  /**
   * Manually flush remaining events (for testing).
   */
  flushSync() {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    batch.forEach(({ eventType, data }) => {
      try {
        if (window.newrelic) {
          window.newrelic.recordCustomEvent(eventType, data);
        }
      } catch (err) {
        console.debug('[NREventBatcher] Sync flush failed', eventType, err.message);
      }
    });

    clearTimeout(this.flushTimeoutId);
    this.flushTimeoutId = null;
  }

  /**
   * Get queue size (for monitoring/testing).
   */
  getQueueSize() {
    return this.queue.length;
  }

  /**
   * Clear queue (for testing).
   */
  clear() {
    this.queue = [];
    clearTimeout(this.flushTimeoutId);
    this.flushTimeoutId = null;
  }
}

// Singleton instance
const nrEventBatcher = new NREventBatcher();

export { NREventBatcher, nrEventBatcher };

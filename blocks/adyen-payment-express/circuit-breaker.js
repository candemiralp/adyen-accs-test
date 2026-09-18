/**
 * Circuit Breaker for cart refresh queries
 * Prevents cascading failures by skipping failed queries for 30s,
 * with fallback to stale cache and dropin state.
 *
 * State Machine: Closed → Open → Half-Open → Closed / Open
 * ponytail: Native JS only; no external libraries. ~1.8KB minified.
 */

class CircuitBreaker {
  constructor(config = {}, { logger = console, nrCustomEvents = null } = {}) {
    this.config = {
      failureThreshold: 3,
      errorRateThreshold: 0.5,
      windowDurationMs: 300000, // 5 minutes
      recoveryDelayMs: 30000, // 30 seconds
      testFireTimeoutMs: 5000, // 5 seconds
      ...config,
    };

    this.logger = logger;
    this.nrCustomEvents = nrCustomEvents;

    this.state = 'Closed';
    this.failureCount = 0;
    this.window = []; // { timestamp, success }
    this.lastSuccessfulTotal = null;
    this.lastError = null;
    this.openedAt = null;
    this.halfOpenTestInProgress = false;
  }

  /**
   * Wrap a query with circuit breaker logic.
   * @param {Function} queryFn - Async function that returns cart total
   * @param {Function} fallbackFn - Sync function that returns fallback total or null
   * @returns {Promise<number|null>} Cart total or fallback or null
   */
  async call(queryFn, fallbackFn) {
    // State: Closed — attempt query
    if (this.state === 'Closed') {
      try {
        const result = await queryFn();
        this.recordSuccess();
        this.lastSuccessfulTotal = result;
        return result;
      } catch (err) {
        this.recordFailure(err);
        if (this.shouldOpen()) {
          this.transitionTo('Open');
        }
        // Closed state: return fallback on error (graceful degradation)
        return fallbackFn();
      }
    }

    // State: Open — skip query, use fallback
    if (this.state === 'Open') {
      if (this.shouldTransitionToHalfOpen()) {
        this.transitionTo('Half-Open');
        // Fall through to Half-Open logic below
      } else {
        // Still in Open, return fallback immediately
        const fallback = fallbackFn();
        if (!fallback) {
          this.logWarning('No fallback available', {
            state: this.state,
            failureCount: this.failureCount,
            errorRate: this.getErrorRate(),
            lastError: this.lastError?.message,
          });
        }
        return fallback;
      }
    }

    // State: Half-Open — send single test fire
    if (this.state === 'Half-Open') {
      // Thread safety: flag checked and set synchronously before await,
      // preventing concurrent test-fires in JavaScript's single-threaded model
      if (this.halfOpenTestInProgress) {
        // Test already in flight; return fallback
        return fallbackFn();
      }

      this.halfOpenTestInProgress = true;
      try {
        const result = await CircuitBreaker.callWithTimeout(queryFn, this.config.testFireTimeoutMs);
        this.halfOpenTestInProgress = false;
        this.recordSuccess();
        this.transitionTo('Closed');
        this.lastSuccessfulTotal = result;
        return result;
      } catch (err) {
        this.halfOpenTestInProgress = false;
        this.recordFailure(err);
        this.transitionTo('Open');
        return fallbackFn();
      }
    }

    return null;
  }

  /**
   * Call a function with a timeout wrapper.
   */
  static callWithTimeout(fn, timeoutMs) {
    return Promise.race([
      fn(),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Record a success: add to window, reset consecutive failures.
   */
  recordSuccess() {
    this.window.push({ timestamp: Date.now(), success: true });
    this.pruneWindow();
    this.failureCount = 0;
  }

  /**
   * Record a failure: add to window, increment consecutive failures.
   */
  recordFailure(err) {
    this.window.push({ timestamp: Date.now(), success: false });
    this.pruneWindow();
    this.failureCount += 1;
    this.lastError = err;
  }

  /**
   * Prune window to entries within the last windowDurationMs.
   */
  pruneWindow() {
    const now = Date.now();
    this.window = this.window.filter(
      (entry) => now - entry.timestamp < this.config.windowDurationMs,
    );
  }

  /**
   * Determine if circuit should open.
   * Opens on: 3 consecutive failures OR >50% error rate in window.
   */
  shouldOpen() {
    if (this.failureCount >= this.config.failureThreshold) {
      return true;
    }
    if (this.window.length > 0) {
      const errorRate = this.getErrorRate();
      if (errorRate >= this.config.errorRateThreshold) {
        return true;
      }
    }
    return false;
  }

  /**
   * Determine if circuit should transition to Half-Open.
   * Half-Open after recoveryDelayMs in Open state.
   */
  shouldTransitionToHalfOpen() {
    return (
      this.openedAt
      && Date.now() - this.openedAt >= this.config.recoveryDelayMs
    );
  }

  /**
   * Calculate error rate in current window.
   */
  getErrorRate() {
    if (this.window.length === 0) {
      return 0;
    }
    const failures = this.window.filter((e) => !e.success).length;
    return failures / this.window.length;
  }

  /**
   * Transition to a new state and emit logs/metrics.
   */
  transitionTo(newState) {
    const oldState = this.state;
    this.state = newState;
    this.lastTransitionAt = Date.now();

    const reason = this.getTransitionReason(oldState, newState);
    this.logTrace('Circuit transition', {
      from: oldState,
      to: newState,
      reason,
      failureCount: this.failureCount,
      errorRate: this.getErrorRate().toFixed(2),
      windowSize: this.window.length,
      timestamp: new Date().toISOString(),
    });

    // Reset counters on open
    if (newState === 'Open') {
      this.openedAt = Date.now();
      this.recordNewRelicTransition(oldState, newState, reason);
    }

    // Reset on close
    if (newState === 'Closed') {
      this.failureCount = 0;
      this.window = [];
      this.recordNewRelicTransition(oldState, newState, 'test_success');
    }
  }

  /**
   * Describe why the transition happened.
   */
  getTransitionReason(oldState, newState) {
    if (oldState === 'Closed' && newState === 'Open') {
      if (this.failureCount >= this.config.failureThreshold) {
        return `consecutive_failures:${this.failureCount}`;
      }
      return `error_rate:${(this.getErrorRate() * 100).toFixed(0)}%`;
    }
    if (oldState === 'Open' && newState === 'Half-Open') {
      return 'recovery_delay_elapsed';
    }
    if (oldState === 'Half-Open' && newState === 'Closed') {
      return 'test_success';
    }
    if (oldState === 'Half-Open' && newState === 'Open') {
      return 'test_failure';
    }
    return 'unknown';
  }

  /**
   * Emit New Relic custom event on transition.
   */
  recordNewRelicTransition(oldState, newState, reason) {
    if (!this.nrCustomEvents) {
      return;
    }
    try {
      this.nrCustomEvents.recordCustomEvent('adyen_circuit_transition', {
        state_before: oldState,
        state_after: newState,
        reason,
        timestamp: Date.now(),
      });
    } catch (err) {
      this.logger.warn('Failed to record NR transition event', err);
    }
  }

  /**
   * Expose current state for monitoring.
   */
  getState() {
    return this.state;
  }

  /**
   * Manual reset (testing / admin).
   */
  reset() {
    this.state = 'Closed';
    this.failureCount = 0;
    this.window = [];
    this.lastError = null;
    this.openedAt = null;
    this.halfOpenTestInProgress = false;
    this.logTrace('Circuit manually reset');
  }

  /**
   * Logging helpers.
   */
  logTrace(message, data = {}) {
    this.logger.log(`[CircuitBreaker] ${message}`, data);
  }

  logWarning(message, data = {}) {
    this.logger.warn(`[CircuitBreaker] ${message}`, data);
  }
}

// Singleton export
let instance = null;

export function createCircuitBreaker(config, options) {
  if (instance) {
    return instance;
  }
  instance = new CircuitBreaker(config, options);
  return instance;
}

export function getCircuitBreaker() {
  if (!instance) {
    instance = new CircuitBreaker();
  }
  return instance;
}

export default CircuitBreaker;

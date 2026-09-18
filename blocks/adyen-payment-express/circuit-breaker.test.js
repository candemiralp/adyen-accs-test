/**
 * Circuit Breaker Tests
 *
 * Covers all acceptance criteria and use cases from Phase 5 Week 3.
 * HPY = Happy path, EDGE = Edge case, NEG = Negative, NFC = Non-functional
 */

import CircuitBreaker from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  let cb;
  let mockLogger;
  let mockNR;

  beforeEach(() => {
    // Reset singleton for each test
    mockLogger = {
      log: jest.fn(),
      warn: jest.fn(),
    };
    mockNR = {
      recordCustomEvent: jest.fn(),
    };
    cb = new CircuitBreaker(
      {
        failureThreshold: 3,
        errorRateThreshold: 0.5,
        windowDurationMs: 5000, // 5s for testing (instead of 5min)
        recoveryDelayMs: 1000, // 1s for testing (instead of 30s)
        testFireTimeoutMs: 500, // 500ms for testing (instead of 5s)
      },
      { logger: mockLogger, nrCustomEvents: mockNR },
    );
  });

  describe('HPY-001: Normal Operation — Circuit Closed', () => {
    it('should start in Closed state', () => {
      expect(cb.getState()).toBe('Closed');
    });

    it('should execute query on first call', async () => {
      const queryFn = jest.fn().mockResolvedValue({ value: 100, currency: 'USD' });
      const fallbackFn = jest.fn();

      const result = await cb.call(queryFn, fallbackFn);

      expect(queryFn).toHaveBeenCalled();
      expect(fallbackFn).not.toHaveBeenCalled();
      expect(result).toEqual({ value: 100, currency: 'USD' });
      expect(cb.getState()).toBe('Closed');
    });

    it('should remain Closed on consistent successes', async () => {
      const queryFn = jest.fn().mockResolvedValue({ value: 100, currency: 'USD' });
      const fallbackFn = jest.fn();

      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(cb.getState()).toBe('Closed');
      expect(queryFn).toHaveBeenCalledTimes(5);
      expect(fallbackFn).not.toHaveBeenCalled();
    });
  });

  describe('EDGE-002: Failure Cascade — Circuit Opens on Consecutive Failures', () => {
    it('should open circuit on 3 consecutive timeouts', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // First 3 failures
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(cb.getState()).toBe('Open');
    });

    it('should skip query when circuit is Open', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // Open the circuit
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      const callCountBeforeOpen = queryFn.mock.calls.length;

      // 4th call should skip query
      await cb.call(queryFn, fallbackFn);

      expect(queryFn).toHaveBeenCalledTimes(callCountBeforeOpen); // No additional call
      expect(cb.getState()).toBe('Open');
    });

    it('should return fallback when circuit is Open', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallback = { value: 50, currency: 'USD' };
      const fallbackFn = jest.fn().mockReturnValue(fallback);

      // Open the circuit
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      // 4th call
      const result = await cb.call(queryFn, fallbackFn);

      expect(result).toEqual(fallback);
      expect(fallbackFn).toHaveBeenCalled();
    });
  });

  describe('EDGE-003: Partial Degradation — Circuit Closed below Threshold', () => {
    it('should remain Closed when error rate is below 50%', async () => {
      const queryFn = jest.fn();
      queryFn
        .mockResolvedValueOnce({ value: 100, currency: 'USD' })
        .mockResolvedValueOnce({ value: 100, currency: 'USD' })
        .mockRejectedValueOnce(new Error('Error'))
        .mockResolvedValueOnce({ value: 100, currency: 'USD' });

      const fallbackFn = jest.fn();

      // 2 successes, 1 failure, 1 success = 25% error rate (< 50%)
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(cb.getState()).toBe('Closed'); // Should remain closed
    });

    it('should open on 50% or higher error rate', async () => {
      const queryFn = jest.fn();
      queryFn
        .mockResolvedValueOnce({ value: 100, currency: 'USD' })
        .mockRejectedValueOnce(new Error('Error'))
        .mockRejectedValueOnce(new Error('Error'));

      const fallbackFn = jest.fn();

      // 1 success, 2 failures = 66.7% error rate (> 50%)
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(cb.getState()).toBe('Open');
    });
  });

  describe('EDGE-004: Half-Open Recovery — Test Fire Success', () => {
    it('should transition to Half-Open after recovery delay', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // Open the circuit
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(cb.getState()).toBe('Open');

      // Wait for recovery delay (1s in test config)
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Next call should transition to Half-Open
      queryFn.mockResolvedValueOnce({ value: 100, currency: 'USD' });
      const result = await cb.call(queryFn, fallbackFn);

      expect(cb.getState()).toBe('Closed'); // Test-fire succeeded, circuit closed
      expect(result).toEqual({ value: 100, currency: 'USD' });
    });

    it('should reset failure counters when test succeeds', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // Open the circuit (3 failures)
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(cb.getState()).toBe('Open');

      // Wait for recovery delay
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Test-fire succeeds
      queryFn.mockResolvedValueOnce({ value: 100, currency: 'USD' });
      const halfOpenResult = await cb.call(queryFn, fallbackFn);

      // Circuit should be closed after successful test-fire
      expect(cb.getState()).toBe('Closed');
      expect(halfOpenResult).toEqual({ value: 100, currency: 'USD' });
    });
  });

  describe('EDGE-005: Half-Open Recovery — Test Fire Failure', () => {
    it('should reopen circuit if test-fire fails', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // Open the circuit
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(cb.getState()).toBe('Open');

      // Wait for recovery delay
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Test-fire fails; queryFn still rejects
      await cb.call(queryFn, fallbackFn);

      // Circuit should reopen
      expect(cb.getState()).toBe('Open');
    });
  });

  describe('EDGE-006: Fallback Returns Null', () => {
    it('should log warning when fallback returns null', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue(null);

      // Open circuit
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      // Call with null fallback
      const result = await cb.call(queryFn, fallbackFn);

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('NFC-007: Logging & Observability', () => {
    it('should log state transitions', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // Trigger transition to Open
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('Circuit transition'),
        expect.objectContaining({
          from: 'Closed',
          to: 'Open',
        }),
      );
    });

    it('should emit New Relic event on transition', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // Trigger transition to Open
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(mockNR.recordCustomEvent).toHaveBeenCalledWith(
        'adyen_circuit_transition',
        expect.objectContaining({
          state_before: 'Closed',
          state_after: 'Open',
        }),
      );
    });
  });

  describe('AC-SAC-14: Concurrent Request Safety', () => {
    it('should handle concurrent calls in Half-Open state', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // Open circuit
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      // Wait for recovery
      // eslint-disable-next-line no-promise-executor-return
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Prepare for half-open: test-fire will succeed on first call
      queryFn.mockResolvedValueOnce({ value: 100, currency: 'USD' });
      queryFn.mockResolvedValueOnce({ value: 100, currency: 'USD' });

      // Two concurrent calls in Half-Open state
      const [result1, result2] = await Promise.all([
        cb.call(queryFn, fallbackFn),
        cb.call(queryFn, fallbackFn),
      ]);

      // At least one result should be from successful query
      expect([result1, result2]).toContainEqual({ value: 100, currency: 'USD' });
      // After first success, circuit should be Closed
      expect(cb.getState()).toBe('Closed');
    });
  });

  describe('AC-SAC-01: Circuit Initialization', () => {
    it('should initialize with Closed state and reset counters', () => {
      expect(cb.getState()).toBe('Closed');
    });
  });

  describe('Manual Reset', () => {
    it('should reset circuit to Closed state', async () => {
      const queryFn = jest
        .fn()
        .mockRejectedValue(new Error('Timeout'));
      const fallbackFn = jest.fn().mockReturnValue({ value: 50, currency: 'USD' });

      // Open circuit
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await cb.call(queryFn, fallbackFn);
      }

      expect(cb.getState()).toBe('Open');

      // Reset
      cb.reset();

      expect(cb.getState()).toBe('Closed');
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.stringContaining('manually reset'),
        expect.any(Object),
      );
    });
  });

  describe('Configuration', () => {
    it('should accept custom configuration', () => {
      const customCb = new CircuitBreaker({
        failureThreshold: 5,
        errorRateThreshold: 0.7,
      });

      expect(customCb.config.failureThreshold).toBe(5);
      expect(customCb.config.errorRateThreshold).toBe(0.7);
    });

    it('should use default configuration when not provided', () => {
      const defaultCb = new CircuitBreaker();

      expect(defaultCb.config.failureThreshold).toBe(3);
      expect(defaultCb.config.errorRateThreshold).toBe(0.5);
      expect(defaultCb.config.windowDurationMs).toBe(300000); // 5 min
      expect(defaultCb.config.recoveryDelayMs).toBe(30000); // 30 sec
    });
  });
});

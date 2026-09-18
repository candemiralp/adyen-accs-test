/**
 * New Relic Event Batcher Tests
 *
 * Covers batching, fallback, <5ms overhead, and concurrent safety.
 */

import { NREventBatcher } from './nr-events.js';

describe('NREventBatcher', () => {
  let batcher;
  let mockNewRelic;
  let originalNewRelic;

  beforeEach(() => {
    // Setup mock New Relic on actual window object (jsdom)
    mockNewRelic = {
      recordCustomEvent: jest.fn(),
    };
    originalNewRelic = window.newrelic;
    window.newrelic = mockNewRelic;

    // Create fresh batcher instance
    batcher = new NREventBatcher(100, 10);

    jest.clearAllMocks();
  });

  afterEach(() => {
    batcher.clear();
    // Restore original window.newrelic
    if (originalNewRelic) {
      window.newrelic = originalNewRelic;
    } else {
      delete window.newrelic;
    }
    jest.clearAllMocks();
  });

  describe('HPY-001: Normal Operation', () => {
    it('should queue events and flush on threshold', async () => {
      // Record 10 events to trigger flush
      for (let i = 0; i < 10; i += 1) {
        batcher.recordCustomEvent('TestEvent', { index: i });
      }

      // Wait for async flush
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledTimes(10);
      expect(batcher.getQueueSize()).toBe(0);
    });

    it('should flush on timeout (100ms)', async () => {
      batcher.recordCustomEvent('Event1', { value: 1 });
      batcher.recordCustomEvent('Event2', { value: 2 });

      // Wait for 100ms timeout + async flush
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });

      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledTimes(2);
      expect(batcher.getQueueSize()).toBe(0);
    });
  });

  describe('EDGE-002: Batching Behavior', () => {
    it('should coalesce events within 100ms window', async () => {
      batcher.recordCustomEvent('Event1', { id: 1 });
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      batcher.recordCustomEvent('Event2', { id: 2 });
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      batcher.recordCustomEvent('Event3', { id: 3 });

      // Still in 100ms window, should not flush yet
      expect(mockNewRelic.recordCustomEvent).not.toHaveBeenCalled();
      expect(batcher.getQueueSize()).toBe(3);

      // Wait for flush
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledTimes(3);
    });

    it('should flush immediately on threshold (10 events)', async () => {
      for (let i = 0; i < 10; i += 1) {
        batcher.recordCustomEvent(`Event${i}`, { index: i });
      }

      // Async flush should happen immediately
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });

      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledTimes(10);
      expect(batcher.getQueueSize()).toBe(0);
    });

    it('should handle multiple flushes in sequence', async () => {
      // First batch of 10
      for (let i = 0; i < 10; i += 1) {
        batcher.recordCustomEvent(`Batch1Event${i}`, { batch: 1, index: i });
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledTimes(10);

      // Second batch of 5 (threshold not reached, waits for timeout)
      for (let i = 0; i < 5; i += 1) {
        batcher.recordCustomEvent(`Batch2Event${i}`, { batch: 2, index: i });
      }

      // Still waiting for timeout
      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledTimes(10);

      // Wait for 100ms timeout
      await new Promise((resolve) => {
        setTimeout(resolve, 120);
      });

      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledTimes(15);
    });
  });

  describe('NEG-003: Fallback Handling', () => {
    it('should gracefully degrade when window.newrelic unavailable', () => {
      delete window.newrelic;

      const consoleSpy = jest.spyOn(console, 'debug').mockImplementation();

      batcher.recordCustomEvent('TestEvent', { value: 123 });

      // Should fallback to console.debug, no error thrown
      expect(consoleSpy).toHaveBeenCalledWith(
        '[NREventBatcher] TestEvent',
        { value: 123 },
      );

      expect(batcher.getQueueSize()).toBe(0);
      consoleSpy.mockRestore();
    });

    it('should handle recordCustomEvent errors gracefully', async () => {
      mockNewRelic.recordCustomEvent.mockImplementation(() => {
        throw new Error('NR SDK error');
      });

      const consoleSpy = jest.spyOn(console, 'debug').mockImplementation();

      batcher.recordCustomEvent('Event1', { value: 1 });

      // Force flush
      batcher.flushSync();

      // Error logged, no exception thrown
      expect(consoleSpy).toHaveBeenCalledWith(
        '[NREventBatcher] Sync flush failed',
        'Event1',
        'NR SDK error',
      );

      consoleSpy.mockRestore();
    });

    it('should handle window being undefined', () => {
      // Remove newrelic to simulate it being undefined, create fresh batcher
      delete window.newrelic;
      const batcher2 = new NREventBatcher(100, 10);

      const consoleSpy = jest.spyOn(console, 'debug').mockImplementation();

      batcher2.recordCustomEvent('TestEvent', { value: 456 });

      // Should fallback to console.debug
      expect(consoleSpy).toHaveBeenCalledWith(
        '[NREventBatcher] TestEvent',
        { value: 456 },
      );

      consoleSpy.mockRestore();
      batcher2.clear();
    });
  });

  describe('NFC-004: Manual Flush', () => {
    it('should flush synchronously via flushSync()', () => {
      batcher.recordCustomEvent('Event1', { id: 1 });
      batcher.recordCustomEvent('Event2', { id: 2 });

      expect(batcher.getQueueSize()).toBe(2);
      expect(mockNewRelic.recordCustomEvent).not.toHaveBeenCalled();

      batcher.flushSync();

      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledTimes(2);
      expect(batcher.getQueueSize()).toBe(0);
    });

    it('should clear queue without flushing', () => {
      batcher.recordCustomEvent('Event1', { id: 1 });
      batcher.recordCustomEvent('Event2', { id: 2 });

      expect(batcher.getQueueSize()).toBe(2);

      batcher.clear();

      expect(batcher.getQueueSize()).toBe(0);
      expect(mockNewRelic.recordCustomEvent).not.toHaveBeenCalled();
    });
  });

  describe('NFC-005: Performance & Safety', () => {
    it('should add minimal overhead (<5ms per event)', () => {
      const iterations = 100;
      const before = performance.now();

      for (let i = 0; i < iterations; i += 1) {
        batcher.recordCustomEvent('PerfEvent', { index: i });
      }

      const elapsed = performance.now() - before;
      const overheadPerEvent = elapsed / iterations;

      // Overhead per event should be < 5ms (typically <1ms)
      expect(overheadPerEvent).toBeLessThan(5);
    });

    it('should handle concurrent recordCustomEvent calls', async () => {
      // ponytail: may be timing-sensitive on fast CI; monitor first 5 runs for stability
      const recordEvent = (index) => batcher.recordCustomEvent(
        `ConcurrentEvent${index}`,
        { index },
      );

      const promises = [];

      // 20 concurrent calls
      for (let i = 0; i < 20; i += 1) {
        promises.push(
          Promise.resolve().then(() => recordEvent(i)),
        );
      }

      await Promise.all(promises);

      // Should queue up to 20 events (first 10 trigger flush, rest wait for timeout)
      expect(batcher.getQueueSize()).toBeLessThanOrEqual(10);

      // Wait for flushes
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });

      // Verify all calls are ConcurrentEvents (no leakage from other tests)
      const concurrentCalls = mockNewRelic.recordCustomEvent.mock.calls.filter(
        (call) => call[0].startsWith('ConcurrentEvent'),
      );
      expect(concurrentCalls).toHaveLength(20);
      expect(batcher.getQueueSize()).toBe(0);
    });
  });

  describe('NFC-006: Event Attributes', () => {
    it('should preserve event type and data structure', async () => {
      const eventData = {
        cartId: 'cart-123',
        duration_ms: 425,
        cache_hit: true,
        timestamp: '2026-07-09T14:30:45.123Z',
      };

      batcher.recordCustomEvent('CartRefreshSuccess', eventData);

      batcher.flushSync();

      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledWith(
        'CartRefreshSuccess',
        eventData,
      );
    });

    it('should handle nested objects in event data', async () => {
      const eventData = {
        cartId: 'cart-456',
        error: {
          message: 'GraphQL error',
          code: 'TIMEOUT',
        },
        metadata: {
          retryCount: 3,
          tags: ['critical', 'observed'],
        },
      };

      batcher.recordCustomEvent('CartRefreshFailure', eventData);

      batcher.flushSync();

      expect(mockNewRelic.recordCustomEvent).toHaveBeenCalledWith(
        'CartRefreshFailure',
        eventData,
      );
    });
  });
});

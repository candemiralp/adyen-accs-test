/**
 * In-memory cache for cart grand_total queries.
 *
 * Implements 30s TTL memoization with concurrent request coalescing,
 * stale-cache fallback on timeouts, and event-driven invalidation.
 */

/**
 * Cache entry structure.
 * @typedef {Object} CacheEntry
 * @property {*} value - Cached value (e.g., { value: 99.99, currency: 'USD' })
 * @property {number} createdAt - Timestamp when entry was written (ms since epoch)
 * @property {number} accessedAt - Timestamp of last access (ms since epoch)
 * @property {Promise<*>} inFlightPromise - In-flight fetch promise for coalescing
 * @property {boolean} isStale - True if returned after timeout fallback
 * @property {number} staleSinceMs - How long since entry expired (ms)
 */

const cache = new Map();

/**
 * Global stats tracker.
 * @type {{ hits: number, misses: number, expires: number,
 *          invalidations: number, coalesces: number }}
 */
let stats = {
  hits: 0,
  misses: 0,
  expires: 0,
  invalidations: 0,
  coalesces: 0,
};

/**
 * Logs cache operation to console and New Relic.
 * @param {string} event - Event type (hit, miss, expire, invalidate, coalesce, fallback)
 * @param {string} cartId - Cart ID
 * @param {Object} metadata - Additional metadata
 */
function logCacheOperation(event, cartId, metadata = {}) {
  const timestamp = new Date().toISOString();
  const entry = cache.get(cartId);
  const ttlRemaining = entry
    ? Math.max(0, entry.createdAt + (metadata.ttlMs || 30000) - Date.now())
    : null;

  const logData = {
    timestamp,
    event,
    cartId,
    ttlRemaining,
    ...metadata,
  };

  console.debug('[CACHE]', event.toUpperCase(), logData);

  // Send to New Relic if available
  if (typeof window !== 'undefined' && window.newrelic) {
    try {
      window.newrelic.addPageAction(`cart_cache_${event}`, logData);
    } catch (err) {
      console.debug('[CACHE] New Relic logging failed:', err.message);
    }
  }
}

/**
 * Get cached value or fetch via provided function.
 *
 * Implements TTL expiry, concurrent request coalescing, and stale-cache fallback.
 *
 * @param {string} cartId - Cart ID (cache key)
 * @param {Function} fetchFn - Async function that returns the value; signature: () => Promise<*>
 * @param {number} ttlMs - Time-to-live in milliseconds (default: 30000)
 * @param {number} timeoutMs - GraphQL fetch timeout (default: 1000); used for stale-cache fallback
 * @returns {Promise<{ value: *, isStale: boolean, staleSinceMs?: number }>}
 */
export async function get(cartId, fetchFn, ttlMs = 30000, timeoutMs = 1000) {
  const now = Date.now();

  // Validate cart ID
  if (!cartId) {
    const error = new Error('Cart ID is required for cache.get()');
    console.error('[CACHE] CACHE-GET-ERROR', { cartId, error: error.message });
    throw error;
  }

  // Check for existing entry
  const entry = cache.get(cartId);

  // Existing entry and not expired
  if (entry && entry.createdAt + ttlMs > now) {
    stats.hits += 1;
    logCacheOperation('hit', cartId, {
      ttlMs,
      elapsedMs: Math.round(performance.now()),
    });
    return { value: entry.value, isStale: false };
  }

  // Entry expired or missing
  if (entry && entry.createdAt + ttlMs <= now) {
    stats.expires += 1;
    logCacheOperation('expire', cartId, {
      ttlMs,
      staleSinceMs: now - (entry.createdAt + ttlMs),
    });
  }

  // Check for in-flight promise (coalesce concurrent requests)
  if (entry?.inFlightPromise) {
    stats.coalesces += 1;
    logCacheOperation('coalesce', cartId, { waiting: true });
    try {
      const result = await entry.inFlightPromise;
      return { value: result, isStale: false };
    } catch (err) {
      // In-flight fetch failed; fall back to stale cache if available
      if (entry?.value) {
        const staleSinceMs = now - (entry.createdAt + ttlMs);
        logCacheOperation('fallback', cartId, {
          reason: 'coalesced_fetch_failed',
          staleSinceMs,
        });
        return { value: entry.value, isStale: true, staleSinceMs };
      }
      throw err;
    }
  }

  // Cache miss: start fresh fetch
  stats.misses += 1;
  const startTime = performance.now();

  // Create in-flight promise for coalescing
  const inFlightPromise = Promise.race([
    fetchFn(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('GraphQL timeout')), timeoutMs);
    }),
  ])
    .then(
      (value) => {
        // Success: cache the result
        cache.set(cartId, {
          value,
          createdAt: Date.now(),
          accessedAt: Date.now(),
          inFlightPromise: null,
          isStale: false,
        });
        logCacheOperation('miss', cartId, {
          elapsedMs: Math.round(performance.now() - startTime),
          ttlMs,
        });
        return value;
      },
    )
    .catch((err) => {
      // Fetch failed: fall back to stale cache if available
      const staleEntry = cache.get(cartId);
      if (staleEntry?.value) {
        const staleSinceMs = Date.now() - (staleEntry.createdAt + ttlMs);
        logCacheOperation('fallback', cartId, {
          reason: err.message || 'fetch_failed',
          staleSinceMs,
          elapsedMs: Math.round(performance.now() - startTime),
        });
        return staleEntry.value;
      }
      throw err;
    });

  // Store in-flight promise for coalescing
  cache.set(cartId, {
    value: entry?.value || null,
    createdAt: entry?.createdAt || Date.now(),
    accessedAt: Date.now(),
    inFlightPromise,
    isStale: false,
  });

  try {
    const result = await inFlightPromise;
    return { value: result, isStale: false };
  } catch (err) {
    // Fetch failed and no stale cache available
    console.error('[CACHE] FETCH-FAILED', {
      cartId,
      error: err.message,
      elapsedMs: Math.round(performance.now() - startTime),
    });
    throw err;
  }
}

/**
 * Invalidate cache entry for a cart ID.
 *
 * @param {string} cartId - Cart ID to invalidate
 * @param {string} reason - Reason for invalidation
 *   (e.g., 'addToCart', 'setShippingMethod', 'orderPlaced')
 */
export function invalidate(cartId, reason = 'manual') {
  if (cache.has(cartId)) {
    stats.invalidations += 1;
    logCacheOperation('invalidate', cartId, { reason });
    cache.delete(cartId);
  }
}

/**
 * Clear all cache entries.
 */
export function clear() {
  const entriesCleared = cache.size;
  cache.clear();
  console.debug('[CACHE] CLEAR', { entriesCleared });
}

/**
 * Get cache statistics.
 *
 * @returns {Object} Cache stats including hit rate, miss count, expiry count, etc.
 */
export function getStats() {
  const totalRequests = stats.hits + stats.misses;
  const hitRate = totalRequests > 0
    ? ((stats.hits / totalRequests) * 100).toFixed(2)
    : 0;

  return {
    hits: stats.hits,
    misses: stats.misses,
    hitRate: `${hitRate}%`,
    expires: stats.expires,
    invalidations: stats.invalidations,
    coalesces: stats.coalesces,
    entriesInCache: cache.size,
  };
}

/**
 * Reset stats (for testing).
 */
export function resetStats() {
  stats = {
    hits: 0,
    misses: 0,
    expires: 0,
    invalidations: 0,
    coalesces: 0,
  };
}

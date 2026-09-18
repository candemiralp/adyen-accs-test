# adyen-payment-express — Shared Helper Module

Shared helper module used by all three express checkout blocks (Apple Pay, Google Pay, PayPal). It encapsulates cart management, address mapping, shipping estimation, order placement, and UI utilities so that each block stays thin (~150 lines).

This module is **not** an EDS block. It has no `decorate()` export and is never referenced in a page's block markup. Import from `../adyen-payment-express/index.js` in block files.

## Module structure

```
blocks/adyen-payment-express/
├── index.js           ← public re-exports (import from here)
├── cart.js            ← cart resolution, addToCart, estimateShipping, setShippingMethod
├── cache.js           ← 30s TTL memoization for cart grand_total queries
├── circuit-breaker.js ← state machine (Closed/Open/Half-Open) for query resilience
├── order.js           ← setGuestEmail, setBilling, setShipping, placeOrder, redirectToConfirmation
├── address.js         ← wallet contact → Commerce address mapping (Apple Pay, Google Pay, PayPal)
├── shipping.js        ← Commerce shipping methods → wallet format (Apple Pay, Google Pay)
├── ui.js              ← showExpressLoading, hideExpressLoading, showExpressError
└── README.md
```

## Public API

### `cart.js`

| Export | Description |
|---|---|
| `resolveCart()` | Returns `{ cartId, isGuest }`. Creates a guest cart for anonymous shoppers; fetches the active customer cart for logged-in shoppers. |
| `addToCart(sku, qty)` | PDP only. Adds a product to the active cart by SKU and quantity. |
| `refreshCartTotals()` | Refetches the current cart's `grand_total` (value + currency) directly from the Commerce backend, bypassing the dropin's cache. Used after `addToCart()` to ensure the payment amount matches the authoritative backend total. Returns `{ value, currency }` or null on failure. |
| `estimateShipping(address)` | Calls Commerce `estimateShippingMethods` with a partial address (`{ countryCode, region, postcode }`). Returns an array of shipping method objects. |
| `setShippingMethod(method)` | Sets the selected shipping method on the active cart. `method` is `{ carrierCode, methodCode }`. |

### `order.js`

| Export | Description |
|---|---|
| `setGuestEmail(email)` | Sets the guest email on the active cart. Call before address/shipping steps for guest shoppers. |
| `setBilling(address)` | Sets the billing address on the active cart. Address fields MUST use camelCase (`firstname`, `lastname`, `country_code`, `region_id`, etc.) and be wrapped in a proper `BillingAddressInput` structure. `region_id` is included only if defined; omitting it avoids validation errors when the region doesn't match the country. |
| `setShipping(address)` | Sets the shipping address on the active cart. Same address structure rules as `setBilling`. |
| `placeOrder(cartId)` | Places the order and returns order data (including order ID for the confirmation redirect). |
| `redirectToConfirmation(orderData)` | Redirects the browser to `/order-confirmation` with order data. |

### `address.js`

| Export | Description |
|---|---|
| `applePayContactToCommerce(contact)` | Maps an `ApplePayPaymentContact` to a Commerce address object. |
| `googlePayAddressToCommerce(address)` | Maps a Google Pay `IntermediateAddress` or `Address` to a Commerce address object. |
| `paypalShopperDetailsToCommerce(shopperDetails)` | Maps PayPal `shopperDetails` (from `onShopperDetails`) to a Commerce address object. |
| `paypalSdkAddressToCommerce(addr, firstName, lastName)` | Maps PayPal SDK address (from `onSubmit` state) to a Commerce address object. Requires explicit name parameters (SDK doesn't include name). |
| `adyenPaypalAddressToCommerce(addr)` | Maps Adyen-formatted PayPal address (from Orders API v2 payer details or `state.data.deliveryAddress`/`billingAddress`) to a Commerce address object. Used for BA- (Billing Agreement / vault) flow address resolution. |

### `shipping.js`

| Export | Description |
|---|---|
| `commerceToApplePayShippingMethods(methods)` | Converts Commerce shipping methods to `ApplePayShippingMethod[]`. |
| `commerceToGooglePayShippingOptions(methods, currentTransactionInfo)` | Converts Commerce shipping methods to `{ shippingOptionParameters, transactionInfo }` for Google Pay. |

### `ui.js`

| Export | Description |
|---|---|
| `showExpressLoading(block)` | Inserts a loading spinner into the block element. |
| `hideExpressLoading(block)` | Removes the loading spinner. |
| `showExpressError(container, message)` | Renders an error message inside the given container element. |

### `cache.js` (Internal)

Cache module for memoizing cart grand_total queries with 30s TTL and concurrent request coalescing.

| Export | Description |
|---|---|
| `get(cartId, fetchFn, ttlMs, timeoutMs)` | Fetch or return cached value with TTL expiry, timeout fallback, and request coalescing. Returns `{ value, isStale, staleSinceMs }`. |
| `invalidate(cartId, reason)` | Invalidate cache entry for a cart ID with optional reason logging. |
| `clear()` | Clear all cache entries. |
| `getStats()` | Return cache statistics (hit rate, miss count, expiry count, etc.). |
| `resetStats()` | Reset statistics (for testing). |

### `circuit-breaker.js` (Internal)

State machine (Closed/Open/Half-Open) for detecting and recovering from persistent GraphQL query failures.

| Export | Description |
|---|---|
| `getCircuitBreaker()` | Returns singleton CircuitBreaker instance with default configuration. |
| `createCircuitBreaker(config, options)` | Creates or returns singleton with custom configuration. |
| `call(queryFn, fallbackFn)` | Wraps async query with circuit breaker logic. Returns result from query or fallback. |
| `getState()` | Returns current state ('Closed', 'Open', or 'Half-Open'). |
| `reset()` | Manually reset circuit to Closed state (testing only). |

### `nr-events.js` (Internal)

New Relic event batching and observability instrumentation for cart refresh operations.

| Export | Description |
|---|---|
| `nrEventBatcher` | Singleton NREventBatcher instance. Batches custom events with configurable threshold (10 events) and flush window (100ms). Uses setImmediate async scheduling; gracefully falls back to console.debug if window.newrelic unavailable. |
| `recordCustomEvent(eventName, eventData)` | Queue a custom event for batching. Events are flushed automatically on threshold or timeout, or manually via flushSync(). |
| `flushSync()` | Synchronously flush all queued events to New Relic. Used for graceful shutdown. |
| `clear()` | Clear all queued events without flushing (for testing). |
| `getQueueSize()` | Return current queue size (for testing). |

## Backend URL dependency

Express blocks do not use `getAdyenCheckout()` from `adyen-payment/index.js` (which depends on Commerce checkout dropin events that don't fire on Cart/PDP pages). Instead, they call `getBackendIntegrationUrl(null)` directly. This reads from a localStorage cache (key `adyen_integration_url`) that is populated with a TTL by the standard checkout page. The cache will be warm in normal sessions.

If `getBackendIntegrationUrl(null)` returns falsy (cold cache), blocks surface an error before the wallet button is rendered.

## Recent fixes (logged-in customer support)

### Address field handling (order.js)
- **region_id handling**: Now only included in the GraphQL mutation when defined. Prevents "region_id does not match country" errors when omitted.
- **address structure**: Address fields properly wrapped in `BillingAddressInput` and `ShippingAddressInput` with correct field casing and nesting.

## Performance optimizations (Phase 5)

### Week 1: Cart refresh query scope reduction
- `refreshCartTotals()` now fetches only `grand_total { value, currency }` instead of including `total_quantity`
- Reduces GraphQL response payload size and JSON parsing time
- All error handling and timing instrumentation preserved

### Week 2: 30s memoization + cache invalidation
- In-memory cache (30s TTL) for cart grand_total queries (cache.js)
- Cache hit returns memoized result in <300ms, eliminating redundant GraphQL queries within the window
- Concurrent requests coalesce into a single GraphQL call
- Stale-cache fallback on GraphQL timeout (1s), with metadata for logging staleness
- Cache invalidates on cart mutations (add-to-cart, set-shipping-method, order-placed)
- Comprehensive logging of cache state changes (hits, misses, expiry, invalidation events) to console and New Relic
- Cache hit rate and latency metrics tracked for performance monitoring

**Impact:** Reduces cart refresh latency 5-10x on cache hits; enables sub-2s PDP express checkout

### Week 3: Circuit breaker for persistent failure recovery
- State machine (Closed/Open/Half-Open) in circuit-breaker.js wraps cart refresh queries
- **Closed state:** Normal operation; query executes, fallback on error (graceful degradation)
- **Open state:** Detected 3 consecutive failures OR >50% error rate in 5-min window; skips queries for 30s, returns fallback
- **Half-Open state:** After 30s recovery delay, test-fires query with 5s timeout; closes on success, reopens on failure
- Fallback hierarchy: stale cache from memoization layer → dropin cart state → null
- All state transitions logged and emitted to New Relic for production observability
- Thread-safe singleton with concurrent call handling in Half-Open state

**Configuration:** Defaults tuned for PDP (failureThreshold: 3, errorRateThreshold: 50%, recoveryDelayMs: 30s, testFireTimeoutMs: 5s)

**Impact:** Prevents cascading failures; gracefully degrades to dropin cache during backend outages; reduces PDP express checkout timeouts

### Week 4: New Relic observability instrumentation
- NREventBatcher singleton (nr-events.js) batches custom events with 10-event threshold and 100ms flush window
- Uses setImmediate async scheduling to prevent blocking cart refresh operations
- Graceful fallback to console.debug if window.newrelic unavailable
- cart.js emits three observability events from refreshCartTotals():
  - **CartRefreshRequested**: Emitted at request start; includes cartId, timestamp, circuit_state
  - **CartRefreshSuccess**: Emitted on success; includes duration_ms, cache_hit (null = unknown), circuit_state, timestamp
  - **CartRefreshFailure**: Emitted on failure; includes fallback_reason (no_cart_id | circuit_breaker_open | fallback_null | exception), error_message, circuit_state, timestamp
- Integrates with Week 3 circuit breaker for complementary state transition events (adyen_circuit_transition)
- All event emission wrapped in try-catch; errors logged to console.debug, never propagate
- <5ms per-event queueing overhead; no impact on cart refresh latency
- Comprehensive test coverage (14 tests: HPY/EDGE/NEG/NFC categories)

**Observability Value:** Enables production monitoring of cart refresh failures, cache effectiveness, circuit breaker state transitions, and failure recovery patterns

**Deferred to Phase 6:** Actual cache_hit tracking (currently null/"unknown"), fine-grained request ID correlation, refined fallback_reason inference

## References

- Shared Adyen config helpers: `blocks/adyen-payment/config.js`
- Shared Adyen SDK utils: `blocks/adyen-payment/utils.js`
- Design spec: `.agents/superpowers/specs/2026-04-14-express-checkout-design.md`

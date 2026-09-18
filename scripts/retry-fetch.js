/**
 * Sleep utility for delays in retry logic
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Check if verbose logging should be enabled (dev mode only)
 * @returns {boolean}
 */
function shouldLog() {
  return window.location.hostname === 'localhost' || window.location.hostname.includes('.hlx.');
}

/**
 * Request queue to limit concurrent resource loading and prevent rate limiting
 * Max 3 concurrent requests balances throughput with AEM Edge Delivery rate limits
 * Enough parallelism for fast initial page load, but conservative enough to avoid 429s
 */
class RequestQueue {
  constructor(maxConcurrent = 3) {
    this.maxConcurrent = maxConcurrent;
    this.activeRequests = 0;
    this.queue = [];
  }

  async enqueue(fn) {
    // If under limit, execute immediately
    if (this.activeRequests < this.maxConcurrent) {
      this.activeRequests += 1;
      try {
        return await fn();
      } finally {
        this.activeRequests -= 1;
        this.processQueue();
      }
    }

    // Over limit - queue the request
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        this.activeRequests += 1;
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeRequests -= 1;
          this.processQueue();
        }
      });
    });
  }

  processQueue() {
    while (this.activeRequests < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

const requestQueue = new RequestQueue(3);

/**
 * Load CSS with automatic retry on 429 errors
 * @param {string} href - CSS URL to load
 * @returns {Promise<void>}
 */
export async function loadCSSWithRetry(href) {
  return new Promise((resolve) => {
    let attempt = 0;
    const maxRetries = 3;
    const isDev = shouldLog();

    function attemptLoad() {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;

      link.onload = () => {
        resolve();
      };

      link.onerror = () => {
        attempt += 1;
        if (attempt < maxRetries) {
          // exponential backoff: 100ms, 200ms, 400ms
          const delay = Math.min(100 * (2 ** (attempt - 1)), 5000);
          if (isDev) {
            // eslint-disable-next-line no-console
            console.warn(`[retry] CSS failed, attempt ${attempt}/${maxRetries}`);
          }
          setTimeout(attemptLoad, delay);
        } else {
          if (isDev) {
            // eslint-disable-next-line no-console
            console.error(`[retry] CSS failed after ${maxRetries} attempts`);
          }
          // Don't reject - allow page to continue even if CSS fails to load
          resolve();
        }
      };

      document.head.append(link);
    }

    // Check if already loaded
    if (!document.querySelector(`head > link[href="${href}"]`)) {
      attemptLoad();
    } else {
      resolve();
    }
  });
}

/**
 * Retry-aware fetch with exponential backoff for rate limiting (429 errors)
 * Uses request queue to limit concurrent requests and prevent rate limiting
 * @param {string} url - The URL to fetch
 * @param {Object} options - Fetch options
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<Response>} Fetch response
 */
export async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  // Inner retry logic
  const performFetch = async () => {
    let lastError;
    let delay = 100; // Start with 100ms
    let attempt = 0;
    const isDev = shouldLog();

    // eslint-disable-next-line no-await-in-loop
    while (attempt <= maxRetries) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const response = await fetch(url, options);

        // Handle 429 (Too Many Requests) with retry
        if (response.status === 429 && attempt < maxRetries) {
          // Get retry-after header if available, otherwise use exponential backoff
          const retryAfter = response.headers.get('retry-after');
          const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : delay;

          if (isDev) {
            // eslint-disable-next-line no-console
            console.warn(`[retry] 429 on fetch, attempt ${attempt + 1}/${maxRetries}`);
          }

          // eslint-disable-next-line no-await-in-loop
          await sleep(waitTime);
          delay = Math.min(delay * 2, 5000); // Cap at 5 seconds
          attempt += 1;
          // eslint-disable-next-line no-continue
          continue;
        }

        // Success or non-retriable error
        return response;
      } catch (error) {
        lastError = error;

        // Don't retry network errors, only rate limiting
        if (attempt < maxRetries) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(delay);
          delay = Math.min(delay * 2, 5000);
        }
        attempt += 1;
      }
    }

    throw lastError;
  };

  // Use queue to limit concurrent requests (prevents 429 cascade)
  return requestQueue.enqueue(performFetch);
}

/**
 * Dynamic import with retry logic for rate limiting
 * @param {string} modulePath - The module path to import
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<Module>} The imported module
 */
export async function importWithRetry(modulePath, maxRetries = 3) {
  let lastError;
  let delay = 100;
  let attempt = 0;
  const isDev = shouldLog();

  // eslint-disable-next-line no-await-in-loop
  while (attempt <= maxRetries) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require, no-eval
      // eslint-disable-next-line no-await-in-loop, max-len
      return await import(modulePath);
    } catch (error) {
      lastError = error;

      // Check if it's a 429 error (appears in error message)
      if (error.message && error.message.includes('429') && attempt < maxRetries) {
        if (isDev) {
          // eslint-disable-next-line no-console
          console.warn(`[retry] 429 on import, attempt ${attempt + 1}/${maxRetries}`);
        }

        // eslint-disable-next-line no-await-in-loop
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
        attempt += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      // For other errors, also retry with backoff
      if (attempt < maxRetries && error.code !== 'ERR_MODULE_NOT_FOUND') {
        // eslint-disable-next-line no-await-in-loop
        await sleep(delay);
        delay = Math.min(delay * 2, 5000);
        attempt += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      // Don't retry module not found errors
      if (error.code === 'ERR_MODULE_NOT_FOUND') {
        throw error;
      }
      attempt += 1;
    }
  }

  throw lastError;
}

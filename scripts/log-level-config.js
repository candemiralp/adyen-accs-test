/**
 * LOG_LEVEL Configuration for AEM Edge Delivery Services
 * This file is loaded before any other scripts and sets window.LOG_LEVEL
 *
 * To change LOG_LEVEL in production, update the value in config.json
 * or set window.LOG_LEVEL_OVERRIDE in localStorage before page load
 */

(function initLogLevel() {
  // Read from multiple sources in priority order:
  // 1. window.LOG_LEVEL_OVERRIDE (set programmatically)
  // 2. localStorage.LOG_LEVEL (browser persistence)
  // 3. Default to 'error' for production

  const logLevel = window.LOG_LEVEL_OVERRIDE
    || localStorage.getItem('LOG_LEVEL')
    || 'error';

  window.LOG_LEVEL = logLevel;

  // Log that LOG_LEVEL was initialized (use native log to avoid recursion)
  if (window.console && window.console._log) {
    window.console._log('[LOG_LEVEL] Initialized to:', window.LOG_LEVEL);
  }
}());

/**
 * Express Checkout UI Helpers
 *
 * Lightweight loading and error display scoped to the express checkout block
 * container. Intentionally separate from the checkout-page utils so express
 * blocks have no dependency on checkout DOM structure.
 */

/**
 * Show a loading spinner inside the block container.
 * @param {HTMLElement} container
 */
export function showExpressLoading(container) {
  if (!container) return;
  container.classList.add('express-loading');
  container.setAttribute('aria-busy', 'true');

  if (!container.querySelector('.express-spinner')) {
    const spinner = document.createElement('div');
    spinner.className = 'express-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    container.appendChild(spinner);
  }
}

/**
 * Remove the loading spinner from the block container.
 * @param {HTMLElement} container
 */
export function hideExpressLoading(container) {
  if (!container) return;
  container.classList.remove('express-loading');
  container.removeAttribute('aria-busy');

  const spinner = container.querySelector('.express-spinner');
  if (spinner) spinner.remove();
}

/**
 * Show an error message inside the block container.
 * Replaces any previously shown error.
 * @param {HTMLElement} container
 * @param {string} message
 */
export function showExpressError(container, message) {
  if (!container) return;

  const existing = container.querySelector('.express-error');
  if (existing) existing.remove();

  const error = document.createElement('div');
  error.className = 'express-error';
  error.setAttribute('role', 'alert');
  error.textContent = message;

  container.insertBefore(error, container.firstChild);
}

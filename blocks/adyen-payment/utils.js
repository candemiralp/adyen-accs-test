/**
 * Adyen Helper Utilities
 * Common helper functions for Adyen integration
 */

import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';

/**
 * Get the CDN URL for an Adyen card brand logo.
 * @param {string} brand - Card brand identifier (e.g. 'visa', 'mc', 'amex')
 * @param {string} [environment='test'] - Adyen environment ('test' or 'live')
 * @returns {string} Full CDN URL for the card logo SVG
 */
export function getAdyenCDNLogoUrl(brand, environment = 'test') {
  return `https://checkoutshopper-${environment}.adyen.com/checkoutshopper/images/logos/${brand}.svg`;
}

/**
 * Load Adyen Web SDK
 * @param {string} environment - Adyen environment ('test' or 'live')
 * @param {string} [version] - Adyen Web SDK version (defaults to config value or '6.23.0')
 * @returns {Promise<void>}
 */
export async function loadAdyenWebSDK(
  environment = 'test',
  version = getConfigValue('adyen-web-sdk-version') || '6.23.0',
) {
  if (window.AdyenWeb?.AdyenCheckout || window.AdyenCheckout) {
    return Promise.resolve(); // Already loaded
  }

  return new Promise((resolve, reject) => {
    // Load CSS
    const cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet';
    cssLink.href = `https://checkoutshopper-${environment}.adyen.com/checkoutshopper/sdk/${version}/adyen.css`;
    cssLink.setAttribute('crossorigin', 'anonymous');
    cssLink.onerror = () => console.warn('[ADYEN-SDK] CSS failed to load (non-critical)');
    document.head.appendChild(cssLink);

    // Load JS
    const script = document.createElement('script');
    script.src = `https://checkoutshopper-${environment}.adyen.com/checkoutshopper/sdk/${version}/adyen.js`;
    script.async = true;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      console.debug('[ADYEN-SDK] Failed to load Adyen Web SDK');
      reject(new Error('Failed to load Adyen Web SDK'));
    };
    script.setAttribute('crossorigin', 'anonymous');
    document.head.appendChild(script);
  });
}

/**
 * Get AdyenCheckout factory from global scope
 * @returns {Function|undefined} Global AdyenCheckout factory
 */
export function getAdyenCheckoutFactory() {
  if (
    typeof window !== 'undefined'
    && typeof window.AdyenWeb?.AdyenCheckout === 'function'
  ) {
    return window.AdyenWeb.AdyenCheckout;
  }
  if (
    typeof window !== 'undefined'
    && typeof window.AdyenCheckout === 'function'
  ) {
    return window.AdyenCheckout;
  }
  if (
    typeof global !== 'undefined'
    && typeof global.AdyenCheckout === 'function'
  ) {
    return global.AdyenCheckout;
  }
  return undefined;
}

/**
 * Format amount for Adyen (convert to minor units)
 * @param {number} amount - Amount in major units (e.g., 10.50)
 * @param {string} currency - Currency code (e.g., 'USD')
 * @returns {Object} Formatted amount object
 */
export function formatAmount(amount, currency = 'USD') {
  // Most currencies use 2 decimal places, but some use 0 or 3
  const minorUnitsMap = {
    JPY: 0, // Japanese Yen
    KRW: 0, // Korean Won
    CLP: 0, // Chilean Peso
    BHD: 3, // Bahraini Dinar
    JOD: 3, // Jordanian Dinar
    KWD: 3, // Kuwaiti Dinar
    OMR: 3, // Omani Rial
    TND: 3, // Tunisian Dinar
  };

  const minorUnits = minorUnitsMap[currency] ?? 2;
  const value = Math.round(amount * 10 ** minorUnits);

  return {
    value,
    currency,
  };
}

/**
 * Parse amount from Adyen format (minor units) to major units
 * @param {Object} amountObject - Adyen amount object
 * @returns {number} Amount in major units
 */
export function parseAmount(amountObject) {
  const { value, currency } = amountObject;
  const minorUnitsMap = {
    JPY: 0,
    KRW: 0,
    CLP: 0,
    BHD: 3,
    JOD: 3,
    KWD: 3,
    OMR: 3,
    TND: 3,
  };

  const minorUnits = minorUnitsMap[currency] ?? 2;
  return value / 10 ** minorUnits;
}

/**
 * Get browser info for 3DS2 authentication
 * @returns {Object} Browser information
 */
export function getBrowserInfo() {
  return {
    acceptHeader: '*/*',
    colorDepth: window.screen.colorDepth,
    language: navigator.language,
    javaEnabled: false,
    screenHeight: window.screen.height,
    screenWidth: window.screen.width,
    userAgent: navigator.userAgent,
    timeZoneOffset: new Date().getTimezoneOffset(),
  };
}

/**
 * Validate payment result
 * @param {Object} result - Payment result from backend
 * @returns {boolean} True if the result is valid
 */
export function isValidPaymentResult(result) {
  return result && typeof result === 'object' && 'resultCode' in result;
}

/**
 * Check if payment is successful
 * @param {string} resultCode - Result code from Adyen
 * @returns {boolean} True if payment is successful
 */
export function isPaymentSuccessful(resultCode) {
  return ['Authorised', 'Received', 'Pending'].includes(resultCode);
}

/**
 * Check if payment needs additional action
 * @param {Object} result - Payment result
 * @returns {boolean} True if additional action is needed
 */
export function needsAdditionalAction(result) {
  return result.resultCode === 'RedirectShopper' || result.action;
}

/**
 * Extract return URL from current location
 * @param {string} paymentMethod - Payment method code
 * @returns {string} Return URL
 */
export function getReturnUrl(paymentMethod = '') {
  const url = new URL(window.location.href);
  url.searchParams.set('payment', paymentMethod);
  return url.toString();
}

/**
 * General Helper Utilities
 * Shared helper functions across the application
 */

/**
 * Parse a string or boolean value to boolean
 * @param {any} value - Value to parse
 * @param {boolean} defaultValue - Default value if parsing fails
 * @returns {boolean} Parsed boolean value
 */
export function parseBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if (lower === 'true' || lower === '1' || lower === 'yes') {
      return true;
    }
    if (lower === 'false' || lower === '0' || lower === 'no') {
      return false;
    }
  }
  return defaultValue;
}

/**
 * Parse a string or number value to integer
 * @param {any} value - Value to parse
 * @param {number} defaultValue - Default value if parsing fails
 * @returns {number} Parsed integer value
 */
export function parseInteger(value, defaultValue = 0) {
  if (typeof value === 'number') {
    return Math.floor(value);
  }
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

/**
 * Parse a JSON string to object
 * @param {string} value - JSON string to parse
 * @param {any} defaultValue - Default value if parsing fails
 * @returns {any} Parsed object or default value
 */
export function parseJson(value, defaultValue = null) {
  if (!value || typeof value !== 'string') {
    return defaultValue;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn('Failed to parse JSON:', error);
    return defaultValue;
  }
}

/**
 * Parse a comma-separated string to array
 * @param {string|Array} value - String or array to parse
 * @returns {Array} Parsed array
 */
export function parseStringArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/**
 * Call a value if it's a function, otherwise return it
 * @param {any} value - Value or function to call
 * @param {...any} args - Arguments to pass if value is a function
 * @returns {any} Result of function call or the value itself
 */
export function callIfFunction(value, ...args) {
  return typeof value === 'function' ? value(...args) : value;
}

/**
 * Create a debounced function
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function} Debounced function
 */
export function debounce(func, wait = 300) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Show loading indicator
 * @param {HTMLElement} element - Element to show loading on
 */
export function showLoading(element) {
  if (!element) return;
  element.classList.add('loading');
  element.setAttribute('aria-busy', 'true');
}

/**
 * Hide loading indicator
 * @param {HTMLElement} element - Element to hide loading on
 */
export function hideLoading(element) {
  if (!element) return;
  element.classList.remove('loading');
  element.removeAttribute('aria-busy');
}

/**
 * Show error message
 * @param {HTMLElement} container - Container element
 * @param {string} message - Error message
 */
export function showError(container, message) {
  if (!container) return;

  // Find the payment methods content container
  const paymentMethodsContent = document.querySelector(
    '.checkout-payment-methods__content',
  );
  const targetContainer = paymentMethodsContent || container;

  // Clear any existing errors first
  clearError(container);

  // Create error banner with icon
  const errorBanner = document.createElement('div');
  errorBanner.className = 'checkout-payment-methods-error';
  errorBanner.setAttribute('role', 'alert');
  errorBanner.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" fill="#dc3545"/>
      <path d="M12 7v6M12 17h.01" stroke="#fff" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <span>${message}</span>
  `;

  // Insert error after test warning if it exists, otherwise at the beginning
  const testWarning = targetContainer.querySelector(
    '.checkout-payment-methods-test-warning',
  );
  if (testWarning) {
    testWarning.insertAdjacentElement('afterend', errorBanner);
  } else {
    targetContainer.insertBefore(errorBanner, targetContainer.firstChild);
  }
}

/**
 * Clear error messages
 * @param {HTMLElement} container - Container element
 */
export function clearError(container) {
  if (!container) return;

  // Clear old-style error messages
  const errorDiv = container.querySelector('.error-message');
  if (errorDiv) {
    errorDiv.remove();
  }

  // Clear new-style error banners — search both the Preact-managed inner
  // container (.checkout-payment-methods__content) and the outer static
  // container (.checkout__payment-methods) that hosts persisted banners
  // injected before Preact mounts (see showPersistedPaymentError in
  // commerce-checkout.js).
  const paymentMethodsOuter = document.querySelector(
    '.checkout__payment-methods',
  );
  const paymentMethodsContent = document.querySelector(
    '.checkout-payment-methods__content',
  );
  [paymentMethodsOuter, paymentMethodsContent].forEach((el) => {
    if (!el) return;
    el.querySelectorAll('.checkout-payment-methods-error').forEach((banner) => banner.remove());
  });
}

/**
 * Convert Commerce Address to the format used by Adyen (billing address)
 * @param address
 * @returns {{city, country, houseNumberOrName: *|string, postalCode, street, stateOrProvince}}
 */
export function commerceToAdyenBillingAddress(address) {
  if (!address) {
    throw new Error('Address is required for payment processing');
  }
  const houseNumber = address.street?.[0]?.match(/\d+/g)?.[0] || '';
  return {
    city: address.city || '',
    country: address.country?.code || address.country || '',
    houseNumberOrName: houseNumber,
    postalCode: address.postCode || '',
    street: address.street?.join(' ') || '',
    stateOrProvince: address.region?.code || address.region || '',
  };
}

/**
 * Convert Commerce Address to the format used by Adyen (shipping address)
 * @param address
 * @returns {{city, country, houseNumberOrName: *|string, postalCode, street, stateOrProvince}}
 */
export function commerceToAdyenShippingAddress(address) {
  return {
    ...commerceToAdyenBillingAddress(address),
    firstname: address.firstName || '',
    lastname: address.lastName || '',
  };
}

/**
 * Check if an Adyen action should be handled natively in-page (not via browser redirect).
 * Returns true for threeDS2 actions (fingerprint and challenge steps).
 * @param {Object|null|undefined} action - The action object from Adyen response
 * @returns {boolean}
 */
export function isNative3DSAction(action) {
  return action?.type === 'threeDS2';
}

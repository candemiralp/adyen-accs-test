import { readBlockConfig } from '../../scripts/aem.js';
import { handleAdyenRedirect, buildOrderDetailsUrl } from './redirect.js';
import { preloadCheckoutSuccess, renderCheckoutSuccess } from '../commerce-checkout-success/commerce-checkout-success.js';
import { restoreFromSnapshot } from '../adyen-payment/index.js';

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
  errorTitle: 'Payment Failed',
  // eslint-disable-next-line no-template-curly-in-string
  errorMessage: '<p>Your order <strong>#${orderNumber}</strong> has been created but the payment could not be completed. '
    + 'Please contact our support team within 24 hours to complete your payment, '
    + 'otherwise your order will be cancelled.</p>',
  supportLink: '/support',
  supportLinkText: 'Contact Support',
  orderDetailsLinkText: 'View Order Details',
};

/**
 * Display payment failure error message
 * @param {HTMLElement} block
 * @param {Object} config
 * @param {Object} orderData
 */
function displayPaymentError(block, config, orderData) {
  const orderDetailsUrl = buildOrderDetailsUrl(orderData);
  // Replace ${orderNumber} token in error message
  const errorMessage = config.errorMessage.replace(/\$\{orderNumber\}/g, orderData.number);

  block.innerHTML = `
    <div class="adyen-payment-error" role="alert" aria-live="polite">
      <div class="adyen-payment-error__icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
        </svg>
      </div>
      <h2 class="adyen-payment-error__title">${config.errorTitle}</h2>
      <div class="adyen-payment-error__message">${errorMessage}</div>
      <div class="adyen-payment-error__actions">
        <a href="${config.supportLink}" class="adyen-payment-error__button adyen-payment-error__button--primary">
          ${config.supportLinkText}
        </a>
        <a href="${orderDetailsUrl}" class="adyen-payment-error__button adyen-payment-error__button--secondary">
          ${config.orderDetailsLinkText}
        </a>
      </div>
      <div class="adyen-payment-error__order-info">
        <span>Order #${orderData.number}</span>
      </div>
    </div>
  `;
}

export default async function decorate(block) {
  // Parse configuration using key-value pattern with defaults
  const rawConfig = readBlockConfig(block);
  const config = {
    errorTitle: rawConfig.errortitle || DEFAULT_CONFIG.errorTitle,
    errorMessage: rawConfig.errormessage || DEFAULT_CONFIG.errorMessage,
    supportLink: rawConfig.supportlink || DEFAULT_CONFIG.supportLink,
    supportLinkText: rawConfig.supportlinktext || DEFAULT_CONFIG.supportLinkText,
    orderDetailsLinkText: rawConfig.orderdetailslinktext || DEFAULT_CONFIG.orderDetailsLinkText,
  };

  // Clear block content
  block.innerHTML = '';

  // Append the loader to document.body so it is visible immediately.
  // The block's own section has display:none until decorate() resolves,
  // so any loader placed inside the block would never be seen.
  const $loader = document.createElement('div');
  $loader.className = 'adyen-payment-redirection__loader';
  $loader.innerHTML = '<div class="adyen-payment-redirection__spinner"></div>';
  document.body.appendChild($loader);

  function removeOverlaySpinner() {
    $loader.remove();
  }

  await preloadCheckoutSuccess();

  const result = await handleAdyenRedirect({ removeOverlaySpinner });

  // Handle the result
  if (result.success) {
    restoreFromSnapshot();
    await renderCheckoutSuccess(block, { orderData: result.orderData });
  } else if (!result.success && result.redirect) {
    window.location.href = result.redirect;
  } else if (result.paymentFailed && result.orderData) {
    // Display error message for server-side payment failures
    displayPaymentError(block, config, result.orderData);
  }
}

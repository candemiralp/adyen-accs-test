/**
 * Adyen Payment Additional Action Block
 *
 * Displays additional actions required for certain payment methods based on
 * the order's payment additional_informations.additional_action data.
 *
 * Supported action types:
 * - voucher: PDF/printable vouchers (BACS Direct Debit, Boleto, OXXO, Doku, etc.)
 * - qrCode: QR codes for scanning (WeChat Pay, Pix, Swish, Bancontact mobile, etc.)
 * - await: Pending actions requiring shopper action outside the app (PayTo, bank transfers)
 */

import { events } from '@dropins/tools/event-bus.js';
import { getAdyenCheckout, setPendingOrderData, saveInstanceSnapshot } from '../adyen-payment/index.js';

/**
 * Renders the appropriate action UI based on action type
 * @param {HTMLElement} container - The container to render into
 * @param {Object} action - The action object from additional_informations
 * @param {Object} orderData - The order data for context (e.g., for redirects)
 */
export async function renderAction(container, action, orderData) {
  if (!action || !action.type) {
    return;
  }
  if (action.type === 'redirect') {
    setPendingOrderData(orderData);
    saveInstanceSnapshot();
  }
  const checkout = await getAdyenCheckout();
  checkout.createFromAction(action).mount(container);
}

/**
 * Extracts the additional_action from order payment data
 * @param {Object} orderData - The order data from the event
 * @returns {Object|null} The additional action object or null
 */
function getAdditionalAction(orderData) {
  if (!orderData?.payments?.length) {
    return null;
  }

  // Find the Adyen payment with additional_informations
  const paymentWithAction = orderData.payments.find(
    (payment) => payment.additional_informations?.additional_action,
  );

  if (!paymentWithAction) {
    return null;
  }

  const additionalInfo = paymentWithAction.additional_informations;
  const { additional_action: additionalAction } = additionalInfo;

  // Parse if it's a string (JSON), otherwise return as-is
  if (typeof additionalAction === 'string') {
    try {
      return JSON.parse(additionalAction);
    } catch (e) {
      console.debug('Failed to parse additional_action:', e);
      return null;
    }
  }
  return additionalAction;
}

export default async function decorate(block) {
  const container = document.createElement('div');
  container.className = 'adyen-additional-action-container';
  block.appendChild(container);

  // Listen for order data and render additional actions if present
  events.on('order/data', async (orderData) => {
    // Clear previous content
    container.innerHTML = '';

    const additionalAction = getAdditionalAction(orderData);
    if (additionalAction) {
      if (additionalAction.action.type === 'redirect') {
        setPendingOrderData(orderData);
      }
      await renderAction(container, additionalAction);
    }
  }, { eager: true });
}

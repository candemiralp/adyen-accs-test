/**
 * Shipping Format Converters
 *
 * Converts Commerce ShippingMethod objects into the wallet-specific shapes
 * required by Apple Pay and Google Pay.
 */

/**
 * Convert Commerce shipping methods to Apple Pay ShippingMethod format.
 * @param {Array} methods - Commerce ShippingMethod objects
 * @returns {ApplePayJS.ApplePayShippingMethod[]}
 */
export function commerceToApplePayShippingMethods(methods) {
  return methods.map((method) => ({
    identifier: method.code,
    label: method.carrier?.title || method.title,
    detail: method.title,
    amount: String(method.amount?.value ?? 0),
  }));
}

/**
 * Convert Commerce shipping methods to Google Pay shipping option parameters
 * and return the updated transaction info placeholder.
 *
 * Google Pay requires shippingOptionParameters on the paymentDataRequest and
 * updated transactionInfo (with shipping amount) in the onPaymentDataChanged
 * callback response.
 *
 * @param {Array} methods - Commerce ShippingMethod objects
 * @param {{ value: number, currency: string }} cartTotal - Current cart total
 * @returns {{ shippingOptionParameters: Object, transactionInfo: Object }}
 */
export function commerceToGooglePayShippingOptions(methods, cartTotal = {}) {
  const defaultMethod = methods[0];
  const shippingCost = defaultMethod?.amount?.value ?? 0;
  const currency = cartTotal.currency || defaultMethod?.amount?.currency || 'USD';
  const total = (cartTotal.value ?? 0) + shippingCost;

  const shippingOptionParameters = {
    shippingOptions: methods.map((method, index) => ({
      id: method.code,
      label: `${method.carrier?.title || method.title} — ${method.title}`,
      description: `${currency} ${method.amount?.value?.toFixed(2) ?? '0.00'}`,
      ...(index === 0 ? { selected: true } : {}),
    })),
  };

  const transactionInfo = {
    totalPriceStatus: 'FINAL',
    totalPrice: String(total.toFixed(2)),
    currencyCode: currency,
    displayItems: [
      {
        label: 'Shipping',
        type: 'LINE_ITEM',
        price: String(shippingCost.toFixed(2)),
        status: 'FINAL',
      },
    ],
  };

  return { shippingOptionParameters, transactionInfo };
}

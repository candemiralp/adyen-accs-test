/**
 * Express Checkout Order Helpers
 *
 * All Commerce mutations here are sent directly via CORE_FETCH_GRAPHQL instead
 * of the checkout/order dropin APIs. Every checkout dropin API (setBillingAddress,
 * setShippingAddress, setShippingMethods, setPaymentMethod, setGuestEmailOnCart)
 * reads the cart ID from the dropin's own internal store. After actions.resolve()
 * dismisses the wallet sheet the Adyen component tears down and corrupts that
 * internal state, so any subsequent dropin call silently receives an empty cartId
 * and fails — for both guest and logged-in shoppers.
 *
 * By passing the cartId we already hold from resolveCart() directly to
 * CORE_FETCH_GRAPHQL we bypass the dropin's internal state entirely.
 *
 * The one safe dropin call is dropinPlaceOrder() from the order dropin —
 * confirmed from source: it accepts cartId as an explicit argument and does not
 * read from any internal store.
 */

import { placeOrder as dropinPlaceOrder } from '@dropins/storefront-order/api.js';
import { getUserTokenCookie } from '../../scripts/initializers/index.js';
import {
  rootLink,
  CUSTOMER_ORDER_DETAILS_PATH,
  ORDER_DETAILS_PATH,
  CORE_FETCH_GRAPHQL,
} from '../../scripts/commerce.js';

// Placeholder used when the wallet payment method does not provide a phone number.
// Commerce requires a non-empty telephone for address mutations.
const TELEPHONE_PLACEHOLDER = '0000000000';

/**
 * Build a Commerce AddressInput object from our internal CommerceAddress shape.
 * @param {Object} address
 * @returns {Object}
 */
function toAddressInput(address) {
  const result = {
    firstname: address.firstName,
    lastname: address.lastName,
    street: Array.isArray(address.street) ? address.street : [address.street],
    city: address.city,
    country_code: address.countryCode,
    postcode: address.postcode || '',
    region: address.region || '',
    telephone: address.telephone || TELEPHONE_PLACEHOLDER,
  };

  // Only include region_id if it's defined; omit it if null/undefined
  // to avoid validation errors when the region_id doesn't match the country
  if (address.regionId !== undefined && address.regionId !== null) {
    result.region_id = address.regionId;
  }

  return result;
}

/**
 * Set the guest email on the cart (guest checkout only).
 *
 * @param {string} email
 * @param {string} cartId
 * @returns {Promise<void>}
 */
export async function setGuestEmail(email, cartId) {
  const { errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
    `mutation setGuestEmail($cartId: String!, $email: String!) {
       setGuestEmailOnCart(input: { cart_id: $cartId, email: $email }) {
         cart { id }
       }
     }`,
    { method: 'POST', variables: { cartId, email } },
  );
  if (errors?.length) {
    throw new Error(`setGuestEmailOnCart failed: ${errors[0]?.message}`);
  }
}

/**
 * Set the billing address on the cart.
 *
 * @param {Object} address - CommerceAddress shape from address.js
 * @param {string} cartId
 * @returns {Promise<void>}
 */
export async function setBilling(address, cartId) {
  const { errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
    `mutation setBillingAddress($cartId: String!, $billingAddress: BillingAddressInput!) {
       setBillingAddressOnCart(input: { cart_id: $cartId, billing_address: $billingAddress }) {
         cart { id }
       }
     }`,
    {
      method: 'POST',
      variables: { cartId, billingAddress: { address: toAddressInput(address) } },
    },
  );
  if (errors?.length) {
    throw new Error(`setBillingAddressOnCart failed: ${errors[0]?.message}`);
  }
}

/**
 * Set the shipping address on the cart.
 *
 * @param {Object} address - CommerceAddress shape from address.js
 * @param {string} cartId
 * @returns {Promise<void>}
 */
export async function setShipping(address, cartId) {
  const convertedAddress = toAddressInput(address);
  console.debug('[order-express] setShipping called:', {
    inputAddress: address,
    convertedAddress,
    isComplete: !!(
      convertedAddress.country_code
      && convertedAddress.city
      && convertedAddress.street?.length
    ),
  });

  const { errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
    `mutation setShippingAddress($cartId: String!, $shippingAddress: ShippingAddressInput!) {
        setShippingAddressesOnCart(input: { cart_id: $cartId, shipping_addresses: [$shippingAddress] }) {
          cart { id }
        }
      }`,
    {
      method: 'POST',
      variables: { cartId, shippingAddress: { address: convertedAddress } },
    },
  );
  if (errors?.length) {
    console.error('[order-express] setShippingAddressesOnCart error:', {
      errorMessage: errors[0]?.message,
      errorExtensions: errors[0]?.extensions,
      variables: { cartId, address: { address: convertedAddress } },
    });
    throw new Error(`setShippingAddressesOnCart failed: ${errors[0]?.message}`);
  }
}

/**
 * Set the shipping method on the cart.
 *
 * @param {{ carrierCode: string, methodCode: string }} method
 * @param {string} cartId
 * @returns {Promise<void>}
 */
export async function setShippingMethod(method, cartId) {
  const { errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
    `mutation setShippingMethod($cartId: String!, $methods: [ShippingMethodInput]!) {
       setShippingMethodsOnCart(input: { cart_id: $cartId, shipping_methods: $methods }) {
         cart { id }
       }
     }`,
    {
      method: 'POST',
      variables: {
        cartId,
        methods: [
          { carrier_code: method.carrierCode, method_code: method.methodCode },
        ],
      },
    },
  );
  if (errors?.length) {
    throw new Error(`setShippingMethodsOnCart failed: ${errors[0]?.message}`);
  }
}

/**
 * Place the order and return the order data.
 * dropinPlaceOrder accepts cartId as an explicit argument — confirmed safe.
 * @param {string} cartId
 * @returns {Promise<Object>} orderData
 */
export async function placeOrder(cartId) {
  const orderData = await dropinPlaceOrder(cartId);
  if (!orderData) throw new Error('placeOrder returned empty response');
  return orderData;
}

/**
 * Set the payment method on the cart then place the order.
 *
 * @param {string} cartId
 * @param {string} paymentMethodCode - e.g. 'adyen_googlepay', 'adyen_applepay', 'adyen_paypal'
 * @param {string} [pspReference] - Adyen pspReference from the /payments response
 * @param {string} [donationToken] - Adyen donationToken from the /payments response (optional)
 * @returns {Promise<Object>} orderData
 */
export async function placeOrderWithPayment(
  cartId,
  paymentMethodCode,
  pspReference,
  donationToken,
) {
  const additionalDataRaw = [
    { key: 'pspReference', value: pspReference },
    { key: 'donationToken', value: donationToken },
    // preOrderPspReference lets the App Builder backend register a second
    // orderLookup entry (preOrderPspReference → orderId) so the Adyen
    // AUTHORISATION webhook can find the order when it arrives for the
    // pre-order PSP reference — mirroring the non-express wallet flow.
    { key: 'preOrderPspReference', value: pspReference },
  ];

  // Commerce's KeyValuePair type requires value: String! — filter out null/undefined.
  const additionalData = additionalDataRaw.filter((entry) => entry.value != null);

  const { errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(
    `mutation setPaymentMethod($cartId: String!, $input: PaymentMethodInput!) {
       setPaymentMethodOnCart(input: { cart_id: $cartId, payment_method: $input }) {
         cart { id }
       }
     }`,
    {
      method: 'POST',
      variables: {
        cartId,
        input: { code: paymentMethodCode, additional_data: additionalData },
      },
    },
  );
  if (errors?.length) {
    throw new Error(`setPaymentMethodOnCart failed: ${errors[0]?.message}`);
  }

  const orderData = await dropinPlaceOrder(cartId);
  if (!orderData) throw new Error('placeOrderWithPayment returned empty response');
  return orderData;
}

/**
 * Redirect the shopper to the order details page.
 * Logged-in users go to the customer order details page (orderRef = order number).
 * Guest users go to the guest order details page (orderRef = token, with email).
 * @param {Object} orderData - Order data returned by placeOrder
 */
export function redirectToConfirmation(orderData) {
  // Cache the order data in sessionStorage so the order-details page initializer
  // can pass it directly to the dropin (bypassing the GraphQL fetch). This avoids
  // an order/error → /order-status redirect that can occur when guestOrderByToken
  // returns no data (e.g. token empty or query unsupported).
  try {
    sessionStorage.setItem('recent_order_data', JSON.stringify(orderData));
  } catch {
    // Ignore sessionStorage errors
  }

  const token = getUserTokenCookie();
  if (token) {
    window.location.href = rootLink(
      `${CUSTOMER_ORDER_DETAILS_PATH}?orderRef=${encodeURIComponent(orderData.number)}`,
    );
  } else {
    const orderRef = encodeURIComponent(orderData.token);
    const orderNumber = encodeURIComponent(orderData.number);
    const email = encodeURIComponent(orderData.email || '');
    window.location.href = rootLink(
      `${ORDER_DETAILS_PATH}?orderRef=${orderRef}&orderNumber=${orderNumber}&email=${email}`,
    );
  }
}

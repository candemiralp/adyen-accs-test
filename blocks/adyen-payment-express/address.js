/**
 * Address Mapping — Wallet → Commerce
 *
 * Converts wallet-specific contact/address objects into the AddressInput
 * shape expected by the Commerce dropin setBillingAddress / setShippingAddress APIs.
 */

/**
 * @typedef {Object} CommerceAddress
 * @property {string} firstName
 * @property {string} lastName
 * @property {string[]} street
 * @property {string} city
 * @property {string} countryCode
 * @property {string} [postcode]
 * @property {string} [region]
 * @property {string|number} [regionId]
 * @property {string} [telephone]
 */

/**
 * Convert an Apple Pay ShippingContact / BillingContact to a Commerce AddressInput.
 * Apple Pay surfaces address lines as addressLines[], country as countryCode.
 * @param {ApplePayJS.ApplePayPaymentContact} contact
 * @returns {CommerceAddress}
 */
export function applePayContactToCommerce(contact) {
  // Guard: Apple Pay may omit contact on some platforms or when billing is not
  // requested. Return an empty-but-valid address so Commerce mutations don't throw.
  if (!contact) {
    return {
      firstName: '',
      lastName: '',
      street: [''],
      city: '',
      countryCode: '',
      postcode: '',
      region: '',
      regionId: undefined,
      telephone: '',
    };
  }
  return {
    firstName: contact.givenName || '',
    lastName: contact.familyName || '',
    street: contact.addressLines?.length ? contact.addressLines : [''],
    city: contact.locality || '',
    countryCode: contact.countryCode || '',
    postcode: contact.postalCode || '',
    region: contact.administrativeArea || '',
    regionId: undefined,
    telephone: contact.phoneNumber || '',
  };
}

/**
 * Convert a Google Pay IntermediateAddress or PaymentMethodData address
 * to a Commerce AddressInput.
 * @param {Object} address - Google Pay address object
 * @returns {CommerceAddress}
 */
/**
 * Convert a Google Pay address to a Commerce address.
 * Google Pay does NOT provide shopper name in the address object, only address fields.
 * If no name is available, extract a display name from the email (local-part before @).
 * @param {Object} address - Google Pay address object
 * @param {string} email - Optional email to extract name from
 * @returns {CommerceAddress}
 */
export function googlePayAddressToCommerce(address, email = '') {
  const street = [address.address1, address.address2, address.address3].filter(
    Boolean,
  );

  console.debug('[address-converter] googlePayAddressToCommerce input:', {
    rawAddress: address,
    extractedStreet: street,
  });

  // Google Pay provides address.name if available, otherwise extract from email
  let firstName = '';
  let lastName = '';

  if (address.name) {
    // If Google Pay provides a name, use it
    firstName = address.name.split(' ')[0] || '';
    lastName = address.name.split(' ').slice(1).join(' ') || '';
  } else if (email) {
    // Extract name from email local-part (before @) as fallback
    // Split on dots or underscores: john.doe@example.com → John Doe
    const localPart = email.split('@')[0];
    const nameParts = localPart.split(/[._-]/);
    firstName = nameParts[0]
      ? nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1).toLowerCase()
      : 'Guest';
    lastName = nameParts.slice(1)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join(' ') || '';

    // Adobe Commerce requires both firstName AND lastName to be non-empty
    // If we only have a first name from the email, use it for both
    if (!lastName) {
      lastName = firstName;
    }
  } else {
    // No name or email — use placeholder for both (Adobe Commerce requires non-empty)
    firstName = 'Guest';
    lastName = 'User';
  }

  const result = {
    firstName,
    lastName,
    street: street.length ? street : ['Street address not provided'],
    city: address.locality || '',
    countryCode: address.countryCode || '',
    postcode: address.postalCode || '',
    region: address.administrativeArea || '',
    regionId: undefined,
    telephone: address.phoneNumber || '',
  };

  console.debug('[address-converter] googlePayAddressToCommerce output:', result);

  return result;
}

/**
 * Convert a PayPal ShopperDetails address to a Commerce AddressInput.
 * PayPal provides shippingAddress but not billingAddress — callers should
 * use the shipping address for both when billing is absent.
 * @param {Object} shopperDetails - Adyen PayPal shopperDetails object
 * @returns {CommerceAddress}
 */
export function paypalShopperDetailsToCommerce(shopperDetails) {
  const addr = shopperDetails.shippingAddress || {};
  return {
    firstName: shopperDetails.shopperName?.firstName || '',
    lastName: shopperDetails.shopperName?.lastName || '',
    street: [addr.street || addr.houseNumberOrName || ''].filter(Boolean) || [
      '',
    ],
    city: addr.city || '',
    countryCode: addr.country || '',
    postcode: addr.postalCode || '',
    region: addr.stateOrProvince || '',
    regionId: undefined,
    telephone: shopperDetails.telephoneNumber || '',
  };
}

/**
 * Convert a PayPal JS SDK v2 shipping address (from onShippingAddressChange)
 * to a Commerce AddressInput.
 *
 * PayPal JS SDK uses snake_case field names and provides only a partial
 * address (no street, no name) in onShippingAddressChange. Name and full
 * street arrive later in state.data.deliveryAddress (set by the Adyen SDK
 * after onApprove resolves the full PayPal order).
 *
 * @param {Object} addr - PayPal JS SDK shippingAddress
 * @param {string} [firstName]
 * @param {string} [lastName]
 * @returns {CommerceAddress}
 */
export function paypalSdkAddressToCommerce(addr, firstName = '', lastName = '') {
  const result = {
    firstName,
    lastName,
    street: [addr?.address_line_1 || addr?.street || ''].filter(Boolean) || [''],
    city: addr?.admin_area_2 || addr?.city || '',
    countryCode: addr?.country_code || addr?.country || '',
    postcode: addr?.postal_code || addr?.postalCode || '',
    region: addr?.admin_area_1 || addr?.stateOrProvince || '',
    regionId: undefined,
    telephone: '',
  };

  console.debug('[paypal-address] paypalSdkAddressToCommerce:', {
    input: addr,
    firstName,
    lastName,
    output: result,
    isComplete: !!(result.countryCode && result.city && result.street?.[0]),
  });

  return result;
}

/**
 * Convert an Adyen SDK deliveryAddress / billingAddress (from state.data,
 * populated after onApprove) to a Commerce AddressInput.
 *
 * The Adyen SDK normalises the PayPal order fields into camelCase before
 * storing them in state.data, so the field names differ from the raw
 * PayPal JS SDK address used in onShippingAddressChange.
 *
 * @param {Object} addr - Adyen state.data.deliveryAddress or .billingAddress
 * @returns {CommerceAddress}
 */
export function adyenPaypalAddressToCommerce(addr) {
  if (!addr) {
    console.debug('[paypal-address] adyenPaypalAddressToCommerce received null/undefined addr');
    return {
      firstName: '',
      lastName: '',
      street: [''],
      city: '',
      countryCode: '',
      postcode: '',
      region: '',
      regionId: undefined,
      telephone: '',
    };
  }
  const street = [addr.street, addr.houseNumberOrName].filter(Boolean);
  const result = {
    firstName: addr.firstName || '',
    lastName: addr.lastName || '',
    street: street.length ? street : [''],
    city: addr.city || '',
    countryCode: addr.country || addr.countryCode || '',
    postcode: addr.postalCode || addr.postcode || '',
    region: addr.stateOrProvince || addr.region || '',
    regionId: undefined,
    telephone: addr.telephone || '',
  };

  console.debug('[paypal-address] adyenPaypalAddressToCommerce:', {
    input: addr,
    output: result,
    isComplete: !!(result.countryCode && result.city && result.street?.[0]),
  });

  return result;
}

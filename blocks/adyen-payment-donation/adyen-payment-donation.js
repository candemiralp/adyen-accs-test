/**
 * Adyen Donation Component
 * Implements Adyen Giving Campaign Manager for post-payment donations
 * Documentation: https://docs.adyen.com/online-payments/donations/web-component
 */

import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';

import { adyenFetch } from '../../scripts/adyen-auth.js';
import {
  getAdyenCheckout,
  getAdyenConfiguration,
  getBackendIntegrationUrl,
  getPaymentResult,
} from '../adyen-payment/index.js';
import { getLastPlacedOrderCartId } from '../commerce-checkout/commerce-checkout.js';

let donationComponent = null;
let donationConfig = null;
const scope = getConfigValue('headers.cs.Magento-Store-View-Code') || 'default';

async function _fetchDonationCampaigns(currency, locale = 'en-US', cartId = null) {
  try {
    const backendUrl = getBackendIntegrationUrl();

    if (!backendUrl) {
      console.error('Backend integration URL not found in payment method configuration');
      return null;
    }

    // Log cartId status for debugging donation component initialization
    if (!cartId) {
      console.warn('[Donation] Fetching campaigns without cartId - using unauthenticated request');
    }

    const endpoint = `${backendUrl.replace(/\/$/, '')}/donationCampaigns`;
    const guestEmail = window.localStorage.getItem('adyen_guest_email');
    const shopperId = guestEmail || undefined;
    const response = await adyenFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        currency,
        locale,
        scope,
      }),
    }, { backendUrl, shopperId, cartId });

    if (!response.ok) {
      if (response.status === 405 || response.status === 404) {
        console.info('Donation campaigns endpoint not implemented. Backend integration required.');
        console.info('See README.md for implementation details.');
      } else {
        console.debug('Failed to fetch donation campaigns:', response.statusText);
      }
      return null;
    }

    const data = await response.json();

    // Return first campaign only
    if (data.donationCampaigns && data.donationCampaigns.length > 0) {
      return data.donationCampaigns[0];
    }

    return null;
  } catch (error) {
    console.debug('Error fetching donation campaigns:', error);
    return null;
  }
}

async function handleOnDonate(state, component, orderData) {
  if (!state.isValid) {
    console.error('Invalid donation state');
    return;
  }

  try {
    component.setStatus('loading');

    const lastPaymentdata = await getPaymentResult();

    const config = await getAdyenConfiguration();
    const { merchantAccount } = config;
    const { amount } = state.data;
    const paymentMethod = {
      type: lastPaymentdata.paymentMethod.type === 'sepadirectdebit' ? 'sepadirectdebit' : 'scheme',
    };
    const backendUrl = getBackendIntegrationUrl();
    const donationToken = lastPaymentdata.donationToken || window.sessionStorage.getItem('donationToken');
    const pspReference = lastPaymentdata.pspReference || window.sessionStorage.getItem('pspReference');

    if (!backendUrl) {
      throw new Error('Backend integration URL not found');
    }

    const donationRequest = {
      amount,
      donationCampaignId: donationConfig.id,
      paymentMethod,
      donationOriginalPspReference: pspReference,
      donationToken,
      reference: `${orderData.number}-donation`,
      merchantAccount,
    };

    const endpoint = `${backendUrl.replace(/\/$/, '')}/donations`;
    const guestEmail = window.localStorage.getItem('adyen_guest_email');
    const shopperId = orderData?.email || guestEmail || undefined;
    const response = await adyenFetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        request: donationRequest,
        scope,
      }),
    }, { backendUrl, shopperId });

    if (!response.ok) {
      throw new Error('Donation request failed');
    }

    const result = await response.json();

    if (result.status === 'completed' || result.status === 'pending') {
      component.setStatus('success');
      setTimeout(() => component.unmount(), 3000);
    } else {
      component.setStatus('error');
    }
  } catch (error) {
    console.debug('Error processing donation:', error);
    component.setStatus('error');
  }
}

function handleOnCancel(state, component) {
  component.unmount();
}

/**
 * Create and mount the Adyen Giving Component on order confirmation
 * Improved error handling for missing cartId scenario
 */
export async function mountDonationComponent(container, orderData) {
  try {
    try {
      const lastPaymentdata = await getPaymentResult();
      const donationToken = lastPaymentdata.donationToken || window.sessionStorage.getItem('donationToken');
      const pspReference = lastPaymentdata.pspReference || window.sessionStorage.getItem('pspReference');
      if (!donationToken || !pspReference) {
        // No donation token found, likely not an Adyen payment
        console.debug('[Donation] No donation token/pspReference found - skipping donation component');
        return;
      }
    } catch {
      console.debug('[Donation] Error retrieving payment data - skipping donation component');
      return;
    }

    const checkout = await getAdyenCheckout();
    const config = await getAdyenConfiguration();
    const currency = orderData.grandTotal?.currency || 'USD';
    const totalAmount = orderData.grandTotal?.value || 0;
    const cartId = getLastPlacedOrderCartId();

    // Log when cartId is missing for debugging
    if (!cartId) {
      console.warn('[Donation] cartId unavailable - may use unauthenticated request to fetch campaigns');
    }

    const campaign = await _fetchDonationCampaigns(currency, config.locale, cartId);

    if (!campaign) {
      console.info('No active donation campaigns available');
      return;
    }

    donationConfig = {
      ...campaign,
      showCancelButton: true,
      onDonate: (state, component) => handleOnDonate(state, component, orderData),
      onCancel: handleOnCancel,
    };

    if (campaign.donation.type === 'roundup') {
      donationConfig.commercialTxAmount = { currency, value: totalAmount };
    }

    donationComponent = new window.AdyenWeb.Donation(checkout, donationConfig);
    donationComponent.mount(container);
  } catch (error) {
    console.debug('Error mounting donation component:', error);
  }
}

export function unmountDonationComponent() {
  if (donationComponent) {
    donationComponent.unmount();
    donationComponent = null;
  }
}

export default async function decorate(block) {
  block.classList.add('adyen-payment-donation');
}

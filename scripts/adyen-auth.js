import { getConfigValue } from '@dropins/tools/lib/aem/configs.js';
import { CORE_FETCH_GRAPHQL } from './commerce.js';

let tokenCache = null;
let tokenBackendUrl = null;
let tokenCartId = null;
const REFRESH_THRESHOLD_MS = 60_000;

/**
 * Extract the Commerce bearer token from the Authorization header.
 * This token is injected by the auth dropin initialization on CORE_FETCH_GRAPHQL.
 * Returns null if not authenticated or token not available.
 * @returns {string|null} The Commerce bearer token, or null
 */
function getCommerceToken() {
  try {
    // eslint-disable-next-line no-console
    console.debug('[Adyen] getCommerceToken: attempting to extract from CORE_FETCH_GRAPHQL');
    const authHeader = CORE_FETCH_GRAPHQL.getFetchGraphQlHeader('Authorization');
    // eslint-disable-next-line no-console
    console.debug('[Adyen] getCommerceToken: CORE_FETCH_GRAPHQL returned', {
      hasAuthHeader: !!authHeader,
      authHeaderType: typeof authHeader,
      authHeaderPrefix: authHeader?.substring(0, 30),
      startsWithBearer: authHeader?.startsWith('Bearer '),
    });
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // eslint-disable-next-line no-console
      console.debug('[Adyen] getCommerceToken: no valid Bearer header');
      return null;
    }
    const token = authHeader.substring(7); // Remove "Bearer " prefix
    // eslint-disable-next-line no-console
    console.debug('[Adyen] getCommerceToken: extracted token', {
      length: token.length,
      prefix: token.substring(0, 30),
    });
    return token;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Adyen] getCommerceToken: error', {
      error: error?.message || String(error),
      errorType: error?.constructor?.name,
    });
    return null;
  }
}

function isTokenValid() {
  if (!tokenCache) return false;
  const now = Math.round(Date.now() / 1000);
  return now < tokenCache.expiry - REFRESH_THRESHOLD_MS / 1000;
}

function getBasicAuthHeader() {
  const user = getConfigValue('adyen-guest-token-username');
  const pass = getConfigValue('adyen-guest-token-password');
  if (!user || !pass) return null;
  return `Basic ${btoa(`${user}:${pass}`)}`;
}

async function getGuestToken(backendUrl, cartId) {
  console.debug('[Adyen] getGuestToken called', {
    cartId,
    hasCartId: !!cartId,
    isTokenValid: isTokenValid(),
    isCached: isTokenValid() && tokenBackendUrl === backendUrl && tokenCartId === cartId,
  });

  if (
    isTokenValid()
    && tokenBackendUrl === backendUrl
    && tokenCartId === cartId
  ) {
    console.debug('[Adyen] getGuestToken: returning cached token');
    return tokenCache.token;
  }

  const url = `${backendUrl.replace(/\/$/, '')}/guest-token`;
  const headers = { 'Content-Type': 'application/json' };
  const basicAuth = getBasicAuthHeader();
  if (basicAuth) {
    headers.Authorization = basicAuth;
  }

  console.debug('[Adyen] getGuestToken: requesting new token', {
    url,
    cartId,
    hasBasicAuth: !!basicAuth,
  });

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cartId }),
  });

  if (!response.ok) {
    const errorMsg = `Failed to obtain guest token: ${response.status}`;
    console.error('[Adyen] getGuestToken: token request failed', {
      status: response.status,
      cartId,
    });
    throw new Error(errorMsg);
  }

  const data = await response.json();
  tokenCache = {
    token: data.token,
    expiry: Math.round(Date.now() / 1000) + (data.expiresIn || 300),
  };
  tokenBackendUrl = backendUrl;
  tokenCartId = cartId;

  console.debug('[Adyen] getGuestToken: new token obtained', {
    expiresIn: data.expiresIn,
    cartId,
  });

  return data.token;
}

export async function adyenFetch(url, options = {}, authContext = {}) {
  const { backendUrl, cartId } = authContext;
  const { isGuest = true } = authContext;

  // eslint-disable-next-line no-console
  console.debug('[Adyen] adyenFetch called', {
    url,
    hasBackendUrl: !!backendUrl,
    hasCartId: !!cartId,
    cartId: cartId || 'MISSING',
    isGuest,
    isGuestType: typeof isGuest,
    authContextKeys: Object.keys(authContext),
    authContextIsGuestValue: authContext.isGuest,
  });

  if (!backendUrl || !cartId) {
    console.warn('[Adyen] adyenFetch: missing auth context, making unauthenticated request', {
      missingBackendUrl: !backendUrl,
      missingCartId: !cartId,
    });
    return fetch(url, options);
  }

  let token;
  try {
    // eslint-disable-next-line no-console
    console.debug('[Adyen] Token selection: isGuest value', {
      isGuest,
      type: typeof isGuest,
      isTruthy: !!isGuest,
      isBoolean: typeof isGuest === 'boolean',
      authContextIsGuest: authContext.isGuest,
      authContextIsGuestType: typeof authContext.isGuest,
    });

    if (isGuest) {
      // Guest checkout: get JWT from /guest-token endpoint
      // eslint-disable-next-line no-console
      console.debug('[Adyen] adyenFetch: guest checkout, fetching guest token', { cartId });
      token = await getGuestToken(backendUrl, cartId);
      // eslint-disable-next-line no-console
      console.debug('[Adyen] adyenFetch: guest token obtained successfully');
    } else {
      // Logged-in checkout: use Commerce bearer token
      // eslint-disable-next-line no-console
      console.debug('[Adyen] adyenFetch: logged-in checkout, fetching Commerce token');
      token = getCommerceToken();
      // eslint-disable-next-line no-console
      console.debug('[Adyen] getCommerceToken returned', {
        hasToken: !!token,
        tokenLength: token?.length,
        tokenPrefix: token?.substring(0, 30),
      });
      if (!token) {
        // eslint-disable-next-line no-console
        console.warn('[Adyen] adyenFetch: logged-in checkout but Commerce token not available, falling back to unauthenticated request');
        return fetch(url, options);
      }
      // eslint-disable-next-line no-console
      console.debug('[Adyen] adyenFetch: using Commerce bearer token for logged-in customer');
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[Adyen] adyenFetch: failed to get token', {
      error: error?.message || String(error),
      cartId,
      isGuest,
    });
    return fetch(url, options);
  }

  const makeRequest = (t) => {
    const headers = {
      ...options.headers,
      Authorization: `Bearer ${t}`,
    };
    // eslint-disable-next-line no-console
    console.debug('[FRONTEND-DEBUG] Making request with Bearer token', {
      tokenLength: t.length,
      tokenPrefix: t.substring(0, 50),
      url,
      isGuest,
      headers: {
        'Content-Type': headers['Content-Type'],
        Authorization: headers.Authorization ? `Bearer ${headers.Authorization.substring(7, 57)}...` : 'N/A',
      },
    });
    return fetch(url, {
      ...options,
      headers,
    });
  };

  const response = await makeRequest(token);

  console.debug('[Adyen] adyenFetch: response received', {
    status: response.status,
    statusOk: response.ok,
    isGuest,
  });

  if (response.status === 401 && isGuest) {
    console.warn('[Adyen] adyenFetch: 401 Unauthorized, attempting token refresh');
    tokenCache = null;
    try {
      const newToken = await getGuestToken(backendUrl, cartId);
      console.debug('[Adyen] adyenFetch: refreshed token, retrying request');
      return makeRequest(newToken);
    } catch (error) {
      console.error('[Adyen] adyenFetch: failed to refresh token', {
        error: error?.message || String(error),
      });
      return response;
    }
  }

  return response;
}

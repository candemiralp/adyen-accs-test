import { SignIn } from '@dropins/storefront-auth/containers/SignIn.js';
import { render as authRenderer } from '@dropins/storefront-auth/render.js';
import {
  CUSTOMER_ACCOUNT_PATH,
  CUSTOMER_FORGOTPASSWORD_PATH,
  checkIsAuthenticated,
  rootLink,
} from '../../scripts/commerce.js';

// Initialize
import '../../scripts/initializers/auth.js';

/**
 * Where to send the shopper after signing in: the `returnTo` query parameter when it
 * is a path on this site (e.g. back to checkout to finish a cart recovery), otherwise
 * the account page. Anything pointing off-site is ignored.
 * @returns {string}
 */
export function getSignInDestination() {
  const returnTo = new URLSearchParams(window.location.search).get('returnTo');
  if (returnTo && returnTo.startsWith('/')) {
    try {
      const url = new URL(returnTo, window.location.origin);
      if (url.origin === window.location.origin) {
        return `${url.pathname}${url.search}${url.hash}`;
      }
    } catch {
      // Fall through to the account page
    }
  }
  return rootLink(CUSTOMER_ACCOUNT_PATH);
}

export default async function decorate(block) {
  if (checkIsAuthenticated()) {
    window.location.href = getSignInDestination();
  } else {
    await authRenderer.render(SignIn, {
      routeForgotPassword: () => rootLink(CUSTOMER_FORGOTPASSWORD_PATH),
      routeRedirectOnSignIn: () => getSignInDestination(),
    })(block);
  }
}

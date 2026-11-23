import { CORE_FETCH_GRAPHQL } from '../../scripts/commerce.js';

const SUBSCRIBE_MUTATION = `
  mutation SubscribeEmailToNewsletter($email: String!) {
    subscribeEmailToNewsletter(email: $email) { status }
  }
`;

const MESSAGES = {
  SUBSCRIBED: 'Thanks for subscribing!',
  NOT_ACTIVE: 'Almost there: please confirm your subscription from the email we just sent.',
  error: 'Sorry, we could not subscribe you right now. Please try again later.',
};

/**
 * Newsletter block: authored text plus an email form that subscribes through Commerce.
 * @param {Element} block The block element
 */
export default function decorate(block) {
  const intro = document.createElement('div');
  intro.className = 'newsletter-intro';
  [...block.querySelectorAll(':scope > div > div')].forEach((cell) => intro.append(...cell.childNodes));

  const form = document.createElement('form');
  form.className = 'newsletter-form';
  form.noValidate = true;
  form.innerHTML = `
    <label class="newsletter-label" for="newsletter-email">Email address</label>
    <input id="newsletter-email" class="newsletter-input" type="email" name="email" autocomplete="email" placeholder="Your email address" required>
    <button class="newsletter-submit" type="submit">Subscribe</button>
    <p class="newsletter-message" role="status" aria-live="polite"></p>
  `;

  const input = form.querySelector('input');
  const button = form.querySelector('button');
  const message = form.querySelector('.newsletter-message');

  const showMessage = (text, isError = false) => {
    message.textContent = text;
    message.classList.toggle('newsletter-message--error', isError);
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!input.checkValidity()) {
      showMessage('Please enter a valid email address.', true);
      input.focus();
      return;
    }
    button.disabled = true;
    try {
      const { data, errors } = await CORE_FETCH_GRAPHQL.fetchGraphQl(SUBSCRIBE_MUTATION, {
        variables: { email: input.value.trim() },
      });
      const status = data?.subscribeEmailToNewsletter?.status;
      if (errors?.length || !status) {
        showMessage(errors?.[0]?.message || MESSAGES.error, true);
      } else {
        showMessage(MESSAGES[status] || MESSAGES.SUBSCRIBED);
        form.reset();
      }
    } catch (e) {
      showMessage(MESSAGES.error, true);
    } finally {
      button.disabled = false;
    }
  });

  block.replaceChildren(intro, form);
}

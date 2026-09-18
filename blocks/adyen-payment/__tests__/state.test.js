/**
 * Tests for Adyen Payment Block - State Management
 * Tests for centralized state management of payment flow
 */

// Mock the storage module
import * as storage from '../storage.js';
import {
  setPaymentResult,
  getPaymentResult,
  getPaymentResultSync,
  clearPaymentResult,
  getPreviousOrderData,
  setPaymentResultFetchPromise,
  getPaymentResultFetchPromise,
  setPendingOrderData,
  getPendingOrderData,
  clearPendingOrderData,
  getCheckoutAttemptId,
  clearCheckoutAttemptId,
  setRedirectPaymentCode,
  getRedirectPaymentCode,
  clearRedirectPaymentCode,
  setActiveComponent,
  getActiveComponent,
  setExtraPaymentParams,
  getExtraPaymentParams,
} from '../state.js';

jest.mock('../storage', () => ({
  STORAGE_KEYS: {
    PAYMENT_RESULT: 'adyen_payment_result',
    PENDING_ORDER: 'adyen_pending_order',
    CHECKOUT_ATTEMPT_PREFIX: 'adyen_checkout_attempt_',
    LAST_CHECKOUT_ATTEMPT: 'adyen_last_checkout_attempt',
    REDIRECT_PAYMENT_CODE: 'adyen_redirect_payment_code',
  },
  STORAGE_TTL: {
    INTEGRATION_URL: 3600,
  },
  getJSON: jest.fn(),
  setJSON: jest.fn(),
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
  getWithExpiry: jest.fn(),
  setWithExpiry: jest.fn(),
}));

describe('Adyen Payment State Management', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Payment Result State', () => {
    describe('setPaymentResult & getPaymentResult', () => {
      it('should store payment result in memory and localStorage', async () => {
        const result = {
          pspReference: 'test-ref-123',
          merchantReference: 'merchant-123',
          resultCode: 'Authorised',
        };

        setPaymentResult(result);

        expect(storage.setJSON).toHaveBeenCalledWith(
          'adyen_payment_result',
          result,
        );
      });

      it('should retrieve stored payment result', async () => {
        const result = {
          pspReference: 'test-ref-retrieve',
          resultCode: 'Authorised',
        };

        // Clear cache to force reading from mocked storage
        clearPaymentResult();
        storage.getJSON.mockReturnValue(result);

        const retrieved = await getPaymentResult();

        expect(retrieved).toEqual(result);
      });

      it('should return payment result from cache on subsequent calls', async () => {
        const result = {
          pspReference: 'cached-ref',
          resultCode: 'Authorised',
        };

        setPaymentResult(result);

        const retrieved = await getPaymentResult();

        expect(retrieved).toEqual(result);
      });

      it('should return null when no payment result exists', async () => {
        storage.getJSON.mockReturnValue(null);

        // Clear cache first
        clearPaymentResult();

        const result = await getPaymentResult();

        expect(result).toBeNull();
      });

      it('should handle pending fetch promise', async () => {
        const fetchPromise = Promise.resolve({
          pspReference: 'async-ref',
          resultCode: 'Pending',
        });

        setPaymentResultFetchPromise(fetchPromise);
        storage.getJSON.mockReturnValue(null);

        // Clear cache to force reading from storage/promise
        clearPaymentResult();

        const _result = await getPaymentResult();

        expect(getPaymentResultFetchPromise()).toBe(fetchPromise);
      });

      it('should handle rejected fetch promise gracefully', async () => {
        const fetchPromise = Promise.reject(new Error('Fetch failed'));

        setPaymentResultFetchPromise(fetchPromise);
        storage.getJSON.mockReturnValue(null);

        clearPaymentResult();

        const result = await getPaymentResult();

        // Should not throw, should return null
        expect(result).toBeNull();
      });
    });

    describe('getPaymentResultSync', () => {
      it('should return payment result synchronously from cache', () => {
        const result = {
          pspReference: 'sync-ref',
          resultCode: 'Authorised',
        };

        setPaymentResult(result);

        const retrieved = getPaymentResultSync();

        expect(retrieved).toEqual(result);
      });

      it('should return payment result from storage synchronously', () => {
        const result = {
          pspReference: 'stored-ref',
          resultCode: 'Authorised',
        };

        clearPaymentResult();
        storage.getJSON.mockReturnValue(result);

        const retrieved = getPaymentResultSync();

        expect(retrieved).toEqual(result);
      });

      it('should return null when no result exists', () => {
        clearPaymentResult();
        storage.getJSON.mockReturnValue(null);

        const retrieved = getPaymentResultSync();

        expect(retrieved).toBeNull();
      });
    });

    describe('clearPaymentResult', () => {
      it('should clear payment result from memory and storage', () => {
        const result = {
          pspReference: 'to-clear',
          resultCode: 'Authorised',
        };

        setPaymentResult(result);
        clearPaymentResult();

        expect(storage.removeItem).toHaveBeenCalledWith('adyen_payment_result');
      });

      it('should return null after clearing', async () => {
        const result = {
          pspReference: 'to-clear',
          resultCode: 'Authorised',
        };

        setPaymentResult(result);
        clearPaymentResult();
        storage.getJSON.mockReturnValue(null);

        const retrieved = await getPaymentResult();

        expect(retrieved).toBeNull();
      });
    });

    describe('getPreviousOrderData', () => {
      it('should return payment result with all fields', () => {
        const result = {
          pspReference: 'test-ref',
          merchantReference: 'merchant-123',
          paymentMethod: { type: 'visa' },
          donationToken: 'donation-token',
          action: { type: 'redirect' },
          resultCode: 'Authorised',
        };

        setPaymentResult(result);

        const previousData = getPreviousOrderData();

        expect(previousData).toEqual(result);
      });

      it('should return default object when no data exists', () => {
        clearPaymentResult();
        storage.getJSON.mockReturnValue(null);

        const previousData = getPreviousOrderData();

        expect(previousData).toHaveProperty('pspReference', null);
        expect(previousData).toHaveProperty('merchantReference', null);
        expect(previousData).toHaveProperty('paymentMethod', null);
        expect(previousData).toHaveProperty('donationToken', null);
        expect(previousData).toHaveProperty('action', null);
        expect(previousData).toHaveProperty('resultCode', null);
      });
    });
  });

  describe('Pending Order State', () => {
    describe('setPendingOrderData & getPendingOrderData', () => {
      it('should store pending order data', () => {
        const orderData = {
          orderId: 'order-123',
          total: 99.99,
          status: 'pending',
        };

        setPendingOrderData(orderData);

        expect(storage.setJSON).toHaveBeenCalledWith(
          'adyen_pending_order',
          orderData,
        );
      });

      it('should retrieve pending order data', () => {
        const orderData = {
          orderId: 'order-123',
          total: 99.99,
          status: 'pending',
        };

        storage.getJSON.mockReturnValue(orderData);

        const retrieved = getPendingOrderData();

        expect(retrieved).toEqual(orderData);
      });

      it('should clear pending order when setting to null', () => {
        setPendingOrderData(null);

        expect(storage.removeItem).toHaveBeenCalledWith('adyen_pending_order');
      });

      it('should return null when no pending order exists', () => {
        clearPendingOrderData();
        storage.getJSON.mockReturnValue(null);

        const retrieved = getPendingOrderData();

        expect(retrieved).toBeNull();
      });

      it('should cache pending order in memory', () => {
        const orderData = {
          orderId: 'order-123',
          total: 99.99,
        };

        setPendingOrderData(orderData);

        const retrieved = getPendingOrderData();

        expect(retrieved).toEqual(orderData);
      });
    });

    describe('clearPendingOrderData', () => {
      it('should clear pending order from memory and storage', () => {
        const orderData = {
          orderId: 'order-to-clear',
          total: 99.99,
        };

        setPendingOrderData(orderData);
        clearPendingOrderData();

        expect(storage.removeItem).toHaveBeenCalledWith('adyen_pending_order');
      });
    });
  });

  describe('Checkout Attempt ID', () => {
    describe('getCheckoutAttemptId', () => {
      it('should generate and return attempt ID for new cart', () => {
        storage.getItem.mockReturnValue(null);

        const attemptId1 = getCheckoutAttemptId('cart-new-1');
        const attemptId2 = getCheckoutAttemptId('cart-new-2');

        // Both should be called and stored
        expect(storage.setItem).toHaveBeenCalled();

        // They should be different UUIDs
        expect(attemptId1).toBeTruthy();
        expect(attemptId2).toBeTruthy();
        expect(typeof attemptId1).toBe('string');
        expect(typeof attemptId2).toBe('string');
      });

      it('should return existing attempt ID for same cart', () => {
        const existingId = 'existing-uuid-5678';
        storage.getItem.mockReturnValue(existingId);

        const attemptId = getCheckoutAttemptId('cart-existing');

        expect(attemptId).toBe(existingId);
      });

      it('should fall back to last attempt ID when cart ID is not provided', () => {
        // First, generate and store an attempt ID with a cart
        storage.getItem.mockReturnValue(null);
        const cartId = 'cart-for-fallback-test';
        const _generatedId = getCheckoutAttemptId(cartId);

        // Now call with null cart, should return the last stored ID
        const attemptId = getCheckoutAttemptId(null);

        // Should return either the generated ID (from memory cache) or stored value
        expect(attemptId).toBeTruthy();
        expect(typeof attemptId).toBe('string');
      });

      it('should generate fallback attempt ID when no cart and no last attempt', () => {
        // The state module will use cached lastCheckoutAttemptIdCache if set,
        // so we test that it generates an ID and stores it appropriately
        storage.getItem.mockReturnValue(null);

        const attemptId = getCheckoutAttemptId(null);

        // Should generate a valid UUID
        expect(attemptId).toBeTruthy();
        expect(typeof attemptId).toBe('string');
        // Should be a valid UUID format (rough check)
        expect(attemptId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      });

      it('should store last used attempt ID', () => {
        storage.getItem.mockReturnValue(null);

        const cartId = 'cart-final-test';
        const attemptId = getCheckoutAttemptId(cartId);

        // Should store both the cart-specific key AND the last used key
        expect(storage.setItem).toHaveBeenCalledWith(
          'adyen_last_checkout_attempt',
          attemptId,
        );
      });
    });

    describe('clearCheckoutAttemptId', () => {
      it('should clear attempt ID for specific cart', () => {
        clearCheckoutAttemptId('cart-clear-test');

        expect(storage.removeItem).toHaveBeenCalledWith(
          'adyen_checkout_attempt_cart-clear-test',
        );
      });

      it('should not clear when cart ID is not provided', () => {
        storage.removeItem.mockClear();
        clearCheckoutAttemptId(null);

        expect(storage.removeItem).not.toHaveBeenCalled();
      });

      it('should not clear last attempt ID (preserve for order confirmation)', () => {
        storage.removeItem.mockClear();
        clearCheckoutAttemptId('cart-preserve-test');

        // Should only remove the cart-specific key
        expect(storage.removeItem).toHaveBeenCalledTimes(1);
        expect(storage.removeItem).toHaveBeenCalledWith(
          'adyen_checkout_attempt_cart-preserve-test',
        );
        // Should NOT have been called with the LAST_CHECKOUT_ATTEMPT key
        expect(storage.removeItem).not.toHaveBeenCalledWith(
          'adyen_last_checkout_attempt',
        );
      });
    });
  });

  describe('Redirect Payment Code', () => {
    describe('setRedirectPaymentCode & getRedirectPaymentCode', () => {
      it('should store redirect payment code', () => {
        const code = 'adyen_klarna_US';

        setRedirectPaymentCode(code);

        expect(storage.setItem).toHaveBeenCalledWith(
          'adyen_redirect_payment_code',
          code,
        );
      });

      it('should retrieve stored redirect payment code', () => {
        storage.getItem.mockReturnValue('adyen_affirm_US');

        const code = getRedirectPaymentCode();

        expect(code).toBe('adyen_affirm_US');
      });

      it('should return null when no code is stored', () => {
        storage.getItem.mockReturnValue(null);

        const code = getRedirectPaymentCode();

        expect(code).toBeNull();
      });
    });

    describe('clearRedirectPaymentCode', () => {
      it('should clear redirect payment code', () => {
        clearRedirectPaymentCode();

        expect(storage.removeItem).toHaveBeenCalledWith(
          'adyen_redirect_payment_code',
        );
      });
    });
  });

  describe('Active Component', () => {
    describe('setActiveComponent & getActiveComponent', () => {
      it('should store active component reference', () => {
        const mockComponent = {
          mount: jest.fn(),
          unmount: jest.fn(),
          submit: jest.fn(),
        };

        setActiveComponent(mockComponent);

        const retrieved = getActiveComponent();

        expect(retrieved).toBe(mockComponent);
      });

      it('should return null when no component is set', () => {
        setActiveComponent(null);

        const retrieved = getActiveComponent();

        expect(retrieved).toBeNull();
      });

      it('should replace previous component when new one is set', () => {
        const component1 = { id: 'component-1' };
        const component2 = { id: 'component-2' };

        setActiveComponent(component1);
        expect(getActiveComponent()).toBe(component1);

        setActiveComponent(component2);
        expect(getActiveComponent()).toBe(component2);
      });
    });
  });

  describe('Extra Payment Parameters', () => {
    describe('setExtraPaymentParams & getExtraPaymentParams', () => {
      it('should store extra payment parameters', () => {
        const params = {
          billingAddress: '123 Main St',
          installments: 3,
        };

        setExtraPaymentParams(params);

        const retrieved = getExtraPaymentParams();

        expect(retrieved).toEqual(params);
      });

      it('should return empty object when no params are set', () => {
        setExtraPaymentParams({});

        const retrieved = getExtraPaymentParams();

        expect(retrieved).toEqual({});
      });

      it('should replace previous params when new ones are set', () => {
        const params1 = { billingAddress: '123 Main St' };
        const params2 = { installments: 3 };

        setExtraPaymentParams(params1);
        expect(getExtraPaymentParams()).toEqual(params1);

        setExtraPaymentParams(params2);
        expect(getExtraPaymentParams()).toEqual(params2);
      });

      it('should handle null params (reset to empty object)', () => {
        const params = { someParam: 'value' };

        setExtraPaymentParams(params);
        setExtraPaymentParams(null);

        const retrieved = getExtraPaymentParams();

        expect(retrieved).toEqual({});
      });

      it('should handle complex nested parameters', () => {
        const params = {
          billingAddress: {
            street: '123 Main St',
            city: 'Springfield',
            zip: '12345',
          },
          installments: 6,
          metadata: {
            source: 'mobile',
            version: '2.0',
          },
        };

        setExtraPaymentParams(params);

        const retrieved = getExtraPaymentParams();

        expect(retrieved).toEqual(params);
      });
    });
  });

  describe('State Isolation', () => {
    it('should isolate different state types', () => {
      const paymentResult = { pspReference: 'ref-1' };
      const pendingOrder = { orderId: 'order-1' };
      const params = { installments: 3 };

      setPaymentResult(paymentResult);
      setPendingOrderData(pendingOrder);
      setExtraPaymentParams(params);

      expect(getPaymentResultSync()).toEqual(paymentResult);
      expect(getPendingOrderData()).toEqual(pendingOrder);
      expect(getExtraPaymentParams()).toEqual(params);
    });

    it('should clear one state without affecting others', () => {
      const paymentResult = { pspReference: 'ref-1' };
      const pendingOrder = { orderId: 'order-1' };

      setPaymentResult(paymentResult);
      setPendingOrderData(pendingOrder);

      clearPaymentResult();

      storage.getJSON.mockReturnValue(null);
      expect(getPaymentResultSync()).toBeNull();
      expect(getPendingOrderData()).toEqual(pendingOrder);
    });
  });

  describe('Fetch Promise Tracking', () => {
    it('should set and get fetch promise', () => {
      const mockPromise = Promise.resolve({ success: true });
      setPaymentResultFetchPromise(mockPromise);

      const retrieved = getPaymentResultFetchPromise();

      expect(retrieved).toBe(mockPromise);
    });

    it('should handle null promise', () => {
      setPaymentResultFetchPromise(null);

      const retrieved = getPaymentResultFetchPromise();

      expect(retrieved).toBeNull();
    });
  });
});

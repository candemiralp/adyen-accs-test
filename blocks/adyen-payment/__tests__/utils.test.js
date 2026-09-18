/**
 * Tests for Adyen Payment Block - Utilities
 * Tests for pure utility functions used throughout the payment block
 */

// Mock the @dropins imports before importing the module
import {
  getAdyenCDNLogoUrl,
  formatAmount,
  parseAmount,
  getBrowserInfo,
  getAdyenCheckoutFactory,
} from '../utils.js';

jest.mock('@dropins/tools/lib/aem/configs.js', () => ({
  getConfigValue: jest.fn((key) => {
    const defaults = {
      'adyen-web-sdk-version': '6.23.0',
    };
    return defaults[key];
  }),
}));

describe('Adyen Payment Utilities', () => {
  describe('getAdyenCDNLogoUrl', () => {
    it('should generate correct test environment URL for visa', () => {
      const url = getAdyenCDNLogoUrl('visa', 'test');
      expect(url).toBe(
        'https://checkoutshopper-test.adyen.com/checkoutshopper/images/logos/visa.svg',
      );
    });

    it('should generate correct live environment URL', () => {
      const url = getAdyenCDNLogoUrl('amex', 'live');
      expect(url).toBe(
        'https://checkoutshopper-live.adyen.com/checkoutshopper/images/logos/amex.svg',
      );
    });

    it('should default to test environment', () => {
      const url = getAdyenCDNLogoUrl('mc');
      expect(url).toContain('checkoutshopper-test.adyen.com');
    });

    it('should handle various card brands', () => {
      const brands = ['visa', 'mc', 'amex', 'diners', 'discover'];
      brands.forEach((brand) => {
        const url = getAdyenCDNLogoUrl(brand);
        expect(url).toContain(brand);
        expect(url).toContain('.svg');
      });
    });

    it('should handle lowercase brand names', () => {
      const url = getAdyenCDNLogoUrl('VISA', 'test');
      expect(url).toContain('VISA');
    });
  });

  describe('formatAmount', () => {
    it('should format USD amount to minor units (cents)', () => {
      const result = formatAmount(10.50, 'USD');
      expect(result).toEqual({
        value: 1050,
        currency: 'USD',
      });
    });

    it('should round to nearest cent for USD', () => {
      const result = formatAmount(10.556, 'USD');
      expect(result.value).toBe(1056);
    });

    it('should default to USD currency', () => {
      const result = formatAmount(10.50);
      expect(result.currency).toBe('USD');
    });

    it('should handle JPY (0 decimal places)', () => {
      const result = formatAmount(1000, 'JPY');
      expect(result).toEqual({
        value: 1000,
        currency: 'JPY',
      });
    });

    it('should handle BHD (3 decimal places)', () => {
      const result = formatAmount(10.123, 'BHD');
      expect(result).toEqual({
        value: 10123,
        currency: 'BHD',
      });
    });

    it('should handle zero amount', () => {
      const result = formatAmount(0, 'USD');
      expect(result).toEqual({
        value: 0,
        currency: 'USD',
      });
    });

    it('should handle very large amounts', () => {
      const result = formatAmount(999999.99, 'USD');
      expect(result).toEqual({
        value: 99999999,
        currency: 'USD',
      });
    });

    it('should handle KRW (0 decimal places)', () => {
      const result = formatAmount(1000, 'KRW');
      expect(result).toEqual({
        value: 1000,
        currency: 'KRW',
      });
    });

    it('should handle CLP (0 decimal places)', () => {
      const result = formatAmount(50000, 'CLP');
      expect(result).toEqual({
        value: 50000,
        currency: 'CLP',
      });
    });
  });

  describe('parseAmount', () => {
    it('should parse USD amount from minor units (cents)', () => {
      const result = parseAmount({
        value: 1050,
        currency: 'USD',
      });
      expect(result).toBe(10.50);
    });

    it('should parse JPY amount (0 decimal places)', () => {
      const result = parseAmount({
        value: 1000,
        currency: 'JPY',
      });
      expect(result).toBe(1000);
    });

    it('should parse BHD amount (3 decimal places)', () => {
      const result = parseAmount({
        value: 10123,
        currency: 'BHD',
      });
      expect(result).toBeCloseTo(10.123, 3);
    });

    it('should parse zero amount', () => {
      const result = parseAmount({
        value: 0,
        currency: 'USD',
      });
      expect(result).toBe(0);
    });

    it('should round to nearest major unit for floating point precision', () => {
      const result = parseAmount({
        value: 1050,
        currency: 'USD',
      });
      expect(result).toBeCloseTo(10.50, 2);
    });

    it('should handle large amounts', () => {
      const result = parseAmount({
        value: 99999999,
        currency: 'USD',
      });
      expect(result).toBe(999999.99);
    });

    it('should be inverse of formatAmount', () => {
      const original = 99.99;
      const formatted = formatAmount(original, 'USD');
      const parsed = parseAmount(formatted);
      expect(parsed).toBeCloseTo(original, 2);
    });
  });

  describe('getBrowserInfo', () => {
    beforeEach(() => {
      // Mock window and navigator properties
      Object.defineProperty(window, 'screen', {
        value: {
          colorDepth: 24,
          height: 1080,
          width: 1920,
        },
        writable: true,
      });

      Object.defineProperty(navigator, 'language', {
        value: 'en-US',
        writable: true,
      });

      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Test Browser)',
        writable: true,
      });
    });

    it('should return browser info object', () => {
      const browserInfo = getBrowserInfo();
      expect(browserInfo).toBeDefined();
      expect(typeof browserInfo).toBe('object');
    });

    it('should include required 3DS2 fields', () => {
      const browserInfo = getBrowserInfo();
      expect(browserInfo).toHaveProperty('acceptHeader');
      expect(browserInfo).toHaveProperty('colorDepth');
      expect(browserInfo).toHaveProperty('language');
      expect(browserInfo).toHaveProperty('javaEnabled');
      expect(browserInfo).toHaveProperty('screenHeight');
      expect(browserInfo).toHaveProperty('screenWidth');
      expect(browserInfo).toHaveProperty('userAgent');
      expect(browserInfo).toHaveProperty('timeZoneOffset');
    });

    it('should set acceptHeader to */*', () => {
      const browserInfo = getBrowserInfo();
      expect(browserInfo.acceptHeader).toBe('*/*');
    });

    it('should set javaEnabled to false', () => {
      const browserInfo = getBrowserInfo();
      expect(browserInfo.javaEnabled).toBe(false);
    });

    it('should capture screen dimensions', () => {
      const browserInfo = getBrowserInfo();
      expect(browserInfo.screenHeight).toBe(1080);
      expect(browserInfo.screenWidth).toBe(1920);
      expect(browserInfo.colorDepth).toBe(24);
    });

    it('should capture navigator language', () => {
      const browserInfo = getBrowserInfo();
      expect(browserInfo.language).toBe('en-US');
    });

    it('should capture user agent string', () => {
      const browserInfo = getBrowserInfo();
      expect(browserInfo.userAgent).toContain('Test Browser');
    });

    it('should capture timezone offset', () => {
      const browserInfo = getBrowserInfo();
      expect(typeof browserInfo.timeZoneOffset).toBe('number');
    });
  });

  describe('getAdyenCheckoutFactory', () => {
    beforeEach(() => {
      // Clear global references
      delete window.AdyenWeb;
      delete window.AdyenCheckout;
      delete global.AdyenCheckout;
    });

    it('should return undefined when no Adyen SDK is loaded', () => {
      const factory = getAdyenCheckoutFactory();
      expect(factory).toBeUndefined();
    });

    it('should return AdyenWeb.AdyenCheckout when available', () => {
      const mockCheckout = jest.fn();
      window.AdyenWeb = {
        AdyenCheckout: mockCheckout,
      };

      const factory = getAdyenCheckoutFactory();
      expect(factory).toBe(mockCheckout);
    });

    it('should return window.AdyenCheckout when available', () => {
      const mockCheckout = jest.fn();
      window.AdyenCheckout = mockCheckout;

      const factory = getAdyenCheckoutFactory();
      expect(factory).toBe(mockCheckout);
    });

    it('should prefer AdyenWeb.AdyenCheckout over window.AdyenCheckout', () => {
      const mockAdyenWebCheckout = jest.fn();
      const mockWindowCheckout = jest.fn();
      window.AdyenWeb = {
        AdyenCheckout: mockAdyenWebCheckout,
      };
      window.AdyenCheckout = mockWindowCheckout;

      const factory = getAdyenCheckoutFactory();
      expect(factory).toBe(mockAdyenWebCheckout);
    });

    it('should return global.AdyenCheckout as fallback', () => {
      const mockCheckout = jest.fn();
      global.AdyenCheckout = mockCheckout;

      const factory = getAdyenCheckoutFactory();
      expect(factory).toBe(mockCheckout);
    });

    it('should work when passed to constructor', () => {
      const mockConfig = { clientKey: 'test' };
      const mockCheckoutInstance = { render: jest.fn() };
      const mockCheckout = jest.fn(() => mockCheckoutInstance);

      window.AdyenCheckout = mockCheckout;

      const factory = getAdyenCheckoutFactory();
      const instance = factory(mockConfig);

      expect(mockCheckout).toHaveBeenCalledWith(mockConfig);
      expect(instance).toBe(mockCheckoutInstance);
    });

    afterEach(() => {
      // Cleanup
      delete window.AdyenWeb;
      delete window.AdyenCheckout;
      delete global.AdyenCheckout;
    });
  });

  describe('Amount conversion round-trip', () => {
    it('should round-trip USD amounts', () => {
      const amounts = [0.01, 10.50, 99.99, 1000.00, 9999.99];
      amounts.forEach((amount) => {
        const formatted = formatAmount(amount, 'USD');
        const parsed = parseAmount(formatted);
        expect(parsed).toBeCloseTo(amount, 2);
      });
    });

    it('should round-trip BHD amounts (3 decimals)', () => {
      const amounts = [0.001, 10.123, 99.999];
      amounts.forEach((amount) => {
        const formatted = formatAmount(amount, 'BHD');
        const parsed = parseAmount(formatted);
        expect(parsed).toBeCloseTo(amount, 3);
      });
    });

    it('should handle currency conversion consistency', () => {
      const usd = formatAmount(10.50, 'USD');
      const jpy = formatAmount(1000, 'JPY');

      expect(usd.value).toBe(1050); // cents
      expect(jpy.value).toBe(1000); // whole units

      expect(parseAmount(usd)).toBeCloseTo(10.50, 2);
      expect(parseAmount(jpy)).toBe(1000);
    });
  });

  describe('Edge cases and error handling', () => {
    it('should handle negative amounts gracefully', () => {
      const result = formatAmount(-10.50, 'USD');
      expect(result.value).toBe(-1050);
    });

    it('should handle very small USD amounts', () => {
      const result = formatAmount(0.01, 'USD');
      expect(result.value).toBe(1);
    });

    it('should handle floating point precision issues', () => {
      // JavaScript floating point: 0.1 + 0.2 !== 0.3
      const result = formatAmount(0.1 + 0.2, 'USD');
      expect(result.value).toBe(30); // Should round to 30 cents
    });

    it('should work with parseAmount for unpredictable values', () => {
      const messyAmount = 19.999;
      const formatted = formatAmount(messyAmount, 'USD');
      const parsed = parseAmount(formatted);
      // Should round-trip successfully
      expect(parsed).toBeCloseTo(19.999, 2);
    });
  });
});

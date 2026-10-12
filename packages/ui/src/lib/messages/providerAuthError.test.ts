import { describe, expect, test } from 'bun:test';
import { isLikelyProviderAuthFailure, isLikelyProviderTransportFailure } from './providerAuthError';

/**
 * The exact text a Windows install reported, copied from the user, so the shape
 * that reached them stays recognised.
 */
const windowsReport =
    'Retry budget exhausted after 10 retries: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()';

describe('provider failure shapes', () => {
    test('recognises the retry-and-socket failure a Windows install reported', () => {
        expect(isLikelyProviderTransportFailure(windowsReport)).toBe(true);
    });

    test('recognises a closed socket without the retry prefix', () => {
        expect(isLikelyProviderTransportFailure('The socket connection was closed unexpectedly')).toBe(true);
    });

    test('leaves unrelated text to the generic message', () => {
        expect(isLikelyProviderTransportFailure('Session not found')).toBe(false);
        expect(isLikelyProviderTransportFailure(undefined)).toBe(false);
    });

    test('keeps the two shapes apart', () => {
        expect(isLikelyProviderAuthFailure('token refresh failed')).toBe(true);
        expect(isLikelyProviderTransportFailure('token refresh failed')).toBe(false);
        expect(isLikelyProviderAuthFailure(windowsReport)).toBe(false);
    });
});

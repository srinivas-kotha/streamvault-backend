import { describe, it, expect } from 'vitest';
import {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
} from './jwt';

const testPayload = { userId: 1, username: 'testuser' };

describe('signAccessToken', () => {
  it('returns a string', () => {
    const token = signAccessToken(testPayload);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });
});

describe('verifyAccessToken', () => {
  it('decodes a signed token', () => {
    const token = signAccessToken(testPayload);
    const decoded = verifyAccessToken(token);
    expect(decoded.userId).toBe(1);
    expect(decoded.username).toBe('testuser');
  });

  it('throws on invalid token', () => {
    expect(() => verifyAccessToken('invalid.token.value')).toThrow();
  });
});

describe('signRefreshToken + verifyRefreshToken', () => {
  it('round trips correctly', () => {
    const token = signRefreshToken(testPayload);
    const decoded = verifyRefreshToken(token);
    expect(decoded.userId).toBe(1);
    expect(decoded.username).toBe('testuser');
  });
});

describe('hashToken', () => {
  it('returns consistent hex string', () => {
    const hash1 = hashToken('my-token');
    const hash2 = hashToken('my-token');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns different hashes for different inputs', () => {
    const hash1 = hashToken('token-a');
    const hash2 = hashToken('token-b');
    expect(hash1).not.toBe(hash2);
  });
});

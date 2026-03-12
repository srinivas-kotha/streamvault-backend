import { describe, it, expect, beforeEach } from 'vitest';
import { cacheGet, cacheSet, cacheDel, cacheFlush } from './cache.service';

beforeEach(() => {
  cacheFlush();
});

describe('cacheSet + cacheGet', () => {
  it('returns stored value', () => {
    cacheSet('key1', { name: 'test' }, 60);
    const result = cacheGet<{ name: string }>('key1');
    expect(result).toEqual({ name: 'test' });
  });

  it('stores string values', () => {
    cacheSet('str', 'hello', 60);
    expect(cacheGet<string>('str')).toBe('hello');
  });

  it('stores numeric values', () => {
    cacheSet('num', 42, 60);
    expect(cacheGet<number>('num')).toBe(42);
  });
});

describe('cacheGet', () => {
  it('returns undefined for missing key', () => {
    const result = cacheGet('nonexistent');
    expect(result).toBeUndefined();
  });
});

describe('cacheDel', () => {
  it('removes key', () => {
    cacheSet('to-delete', 'value', 60);
    expect(cacheGet('to-delete')).toBe('value');
    cacheDel('to-delete');
    expect(cacheGet('to-delete')).toBeUndefined();
  });

  it('returns 0 for non-existent key', () => {
    const count = cacheDel('no-such-key');
    expect(count).toBe(0);
  });
});

describe('cacheFlush', () => {
  it('clears all keys', () => {
    cacheSet('a', 1, 60);
    cacheSet('b', 2, 60);
    cacheSet('c', 3, 60);
    expect(cacheGet('a')).toBe(1);
    cacheFlush();
    expect(cacheGet('a')).toBeUndefined();
    expect(cacheGet('b')).toBeUndefined();
    expect(cacheGet('c')).toBeUndefined();
  });
});

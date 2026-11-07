import { describe, expect, it } from 'vitest';

import { randomCode, randomPassword } from './signInPrefill';

describe('sign-in prefill values', () => {
  it('makes a fresh password and a 6-digit code each time', () => {
    const passwords = new Set(Array.from({ length: 20 }, randomPassword));
    expect(passwords.size).toBe(20);
    for (const p of passwords) expect(p).toMatch(/^[A-Z][a-z2-9]{11}-[2-9]{2}$/);
    for (let i = 0; i < 20; i++) expect(randomCode()).toMatch(/^\d{6}$/);
  });
});

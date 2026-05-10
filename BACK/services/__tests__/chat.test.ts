import { describe, expect, it } from 'vitest';

import { normalizeMessages } from '../chat';
import { prepareTransferResult } from '../tools/transfer';

describe('normalizeMessages', () => {
  it('normalizes valid messages array', () => {
    const input = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = normalizeMessages(input);
    expect(result).toHaveLength(2);
    expect(result![0].role).toBe('user');
    expect(result![1].role).toBe('assistant');
  });

  it('returns null for empty array', () => {
    expect(normalizeMessages([])).toBeNull();
  });

  it('returns null for missing content', () => {
    const input = [{ role: 'user' }];
    expect(normalizeMessages(input)).toBeNull();
  });

  it('returns null for non-array input', () => {
    expect(normalizeMessages('not an array')).toBeNull();
    expect(normalizeMessages(null)).toBeNull();
    expect(normalizeMessages(undefined)).toBeNull();
  });
});

describe('prepareTransferResult', () => {
  const validFromWallet = '11111111111111111111111111111111';
  const validToWallet = 'So11111111111111111111111111111111111111112';

  it('prepares transfer for valid params', () => {
    const result = prepareTransferResult(
      { amount: 0.25, token: 'SOL', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('prepared');
    expect(result.preparedAction?.executedOnChain).toBe(false);
    expect(result.preparedAction?.requiresUserSignature).toBe(true);
    expect(result.preparedAction?.fromWallet).toBe(validFromWallet);
    expect(result.preparedAction?.toWallet).toBe(validToWallet);
  });

  it('denies invalid source wallet', () => {
    const result = prepareTransferResult(
      { amount: 0.25, token: 'SOL', recipient: validToWallet },
      'not-a-wallet'
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('INVALID_FROM_WALLET');
  });

  it('denies invalid recipient', () => {
    const result = prepareTransferResult(
      { amount: 0.25, token: 'SOL', recipient: 'not-a-wallet' },
      validFromWallet
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('INVALID_RECIPIENT');
  });

  it('denies non-positive amount', () => {
    const result = prepareTransferResult(
      { amount: 0, token: 'SOL', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('INVALID_AMOUNT');
  });

  it('denies negative amount', () => {
    const result = prepareTransferResult(
      { amount: -1, token: 'SOL', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('denied');
    expect(result.reason).toBe('INVALID_AMOUNT');
  });

  it('defaults token to SOL', () => {
    const result = prepareTransferResult(
      { amount: 1, token: '', recipient: validToWallet },
      validFromWallet
    );

    expect(result.status).toBe('prepared');
    expect(result.preparedAction?.token).toBe('SOL');
  });

  it('includes memo when provided', () => {
    const result = prepareTransferResult(
      { amount: 1, token: 'SOL', recipient: validToWallet, memo: 'Test memo' },
      validFromWallet
    );

    expect(result.status).toBe('prepared');
    expect(result.preparedAction?.memo).toBe('Test memo');
  });
});

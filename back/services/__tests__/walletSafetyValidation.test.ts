import { describe, expect, it } from 'vitest';

import { evaluateWalletSafety, isPendingActionExpired, DEFAULT_WARN_TRANSFER_SOL } from '../domains/transfer/walletSafetyValidation';
import type { OnchainWalletFacts } from '../domains/transfer/walletSafetyValidation';

describe('evaluateWalletSafety', () => {
  const defaultOnchainMock: OnchainWalletFacts = {
    recipient: 'So11111111111111111111111111111111111111112',
    accountExists: true,
    executable: false,
    ownerProgram: '11111111111111111111111111111111',
    lamports: '1000000',
    source: 'solana-rpc',
    providerStatus: 'ok',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };

  it('returns ALLOW for safe recipient parameters', async () => {
    const result = await evaluateWalletSafety(
      {
        userWallet: '11111111111111111111111111111111',
        recipient: 'So11111111111111111111111111111111111111112',
        amount: 1,
        token: 'SOL',
      },
      {
        onchainFetcher: async () => ({
          ...defaultOnchainMock,
        }),
        policy: { warnAmountSol: 5, requireAllowlistAboveWarnThreshold: false },
      }
    );

    expect(result.decisionResult.decision).toBe('ALLOW');
    expect(result.decisionResult.hardReject).toBe(false);
    expect(result.decisionResult.requiresExtraConfirmation).toBe(false);
  });

  it('allows self-transfer to continue through normal guardrails', async () => {
    const wallet = '11111111111111111111111111111111';
    const result = await evaluateWalletSafety(
      {
        userWallet: wallet,
        recipient: wallet,
        amount: 1,
        token: 'SOL',
      },
      {
        onchainFetcher: async () => ({
          ...defaultOnchainMock,
          recipient: wallet,
        }),
        policy: { warnAmountSol: 5, requireAllowlistAboveWarnThreshold: false },
      }
    );

    expect(result.decisionResult.decision).toBe('ALLOW');
    expect(result.decisionResult.reasons.some((item) => item.code === 'SELF_TRANSFER_BLOCKED')).toBe(false);
  });

  it('returns WARN when transfer requires policy-level review', async () => {
    const result = await evaluateWalletSafety(
      {
        userWallet: '11111111111111111111111111111111',
        recipient: 'So11111111111111111111111111111111111111112',
        amount: DEFAULT_WARN_TRANSFER_SOL + 1,
        token: 'SOL',
      },
      {
        onchainFetcher: async () => ({
          ...defaultOnchainMock,
        }),
      }
    );

    expect(result.decisionResult.decision).toBe('WARN');
    expect(result.decisionResult.reasons.some((item) => item.code === 'RECIPIENT_NOT_ALLOWLISTED_OVER_WARN_THRESHOLD')).toBe(true);
    expect(result.decisionResult.requiresExtraConfirmation).toBe(true);
  });

  it('returns REJECT when recipient is executable', async () => {
    const result = await evaluateWalletSafety(
      {
        userWallet: '11111111111111111111111111111111',
        recipient: 'So11111111111111111111111111111111111111112',
        amount: 1,
        token: 'SOL',
      },
      {
        onchainFetcher: async () => ({
          ...defaultOnchainMock,
          executable: true,
          accountCategory: 'program',
        }),
      }
    );

    expect(result.decisionResult.decision).toBe('REJECT');
    expect(result.decisionResult.reasons.some((item) => item.code === 'RECIPIENT_EXECUTABLE')).toBe(true);
  });

  it('rejects invalid destination public key', async () => {
    const result = await evaluateWalletSafety(
      {
        userWallet: '11111111111111111111111111111111',
        recipient: 'not-a-key',
        amount: 1,
        token: 'SOL',
      },
      {
        onchainFetcher: async () => ({
          ...defaultOnchainMock,
        }),
      }
    );

    expect(result.decisionResult.decision).toBe('REJECT');
    expect(result.actionHash).toBe('');
    expect(result.decisionResult.hardReject).toBe(true);
    expect(result.decisionResult.reasons.some((item) => item.code === 'INVALID_PUBLIC_KEY')).toBe(true);
  });

  it('marks proposal expired when timestamp is past-now', () => {
    expect(isPendingActionExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isPendingActionExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it('returns WARN when Solscan no indexa el recipient y Solscan está habilitado', async () => {
    const result = await evaluateWalletSafety(
      {
        userWallet: '11111111111111111111111111111111',
        recipient: 'So11111111111111111111111111111111111111112',
        amount: 1,
        token: 'SOL',
      },
      {
        onchainFetcher: async () => ({
          ...defaultOnchainMock,
        }),
        solscanConfig: { solscanEnabled: true },
        solscanFetcher: async () => ({
          status: 'missing',
          indexed: false,
          hasHistory: false,
          checkedAt: '2026-01-01T00:00:00.000Z',
          failureCode: 'RECIPIENT_NOT_INDEXED_ON_SOLSCAN',
        }),
      }
    );

    expect(result.decisionResult.decision).toBe('WARN');
    expect(result.decisionResult.reasons.some((item) => item.code === 'RECIPIENT_NOT_INDEXED_ON_SOLSCAN')).toBe(true);
    expect(result.decisionResult.sources.some((item) => item.provider === 'solscan' && item.status === 'missing')).toBe(true);
  });

  it('returns WARN with partial failure when Solscan devuelve error y está habilitado', async () => {
    const result = await evaluateWalletSafety(
      {
        userWallet: '11111111111111111111111111111111',
        recipient: 'So11111111111111111111111111111111111111112',
        amount: 1,
        token: 'SOL',
      },
      {
        onchainFetcher: async () => ({
          ...defaultOnchainMock,
        }),
        solscanConfig: { solscanEnabled: true },
        solscanFetcher: async () => ({
          status: 'error',
          indexed: null,
          hasHistory: null,
          checkedAt: '2026-01-01T00:00:00.000Z',
          failureCode: 'PROVIDER_PARTIAL_FAILURE',
        }),
      }
    );

    expect(result.decisionResult.decision).toBe('WARN');
    expect(result.decisionResult.reasons.some((item) => item.code === 'PROVIDER_PARTIAL_FAILURE')).toBe(true);
    expect(result.decisionResult.sources.some((item) => item.provider === 'solscan' && item.status === 'error')).toBe(true);
  });

  it('keeps ALLOW when Solscan indica wallet indexada', async () => {
    const result = await evaluateWalletSafety(
      {
        userWallet: '11111111111111111111111111111111',
        recipient: 'So11111111111111111111111111111111111111112',
        amount: 1,
        token: 'SOL',
      },
      {
        onchainFetcher: async () => ({
          ...defaultOnchainMock,
        }),
        policy: { warnAmountSol: 5, requireAllowlistAboveWarnThreshold: false },
        solscanConfig: { solscanEnabled: true },
        solscanFetcher: async () => ({
          status: 'ok',
          indexed: true,
          hasHistory: true,
          checkedAt: '2026-01-01T00:00:00.000Z',
        }),
      }
    );

    expect(result.decisionResult.decision).toBe('ALLOW');
    expect(result.decisionResult.reasons.some((item) => item.code === 'RECIPIENT_NOT_INDEXED_ON_SOLSCAN')).toBe(false);
    expect(result.decisionResult.sources.some((item) => item.provider === 'solscan' && item.status === 'ok')).toBe(true);
  });
});

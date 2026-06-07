import { describe, expect, it } from 'vitest';
import { validateDynamicWalletClaims } from '../auth/dynamic';

const WALLET_ADDRESS = 'Wallet1111111111111111111111111111111111';

describe('Dynamic auth claim validation', () => {
  it('accepts a Dynamic token payload that verifies the wallet without user:basic scope', () => {
    const result = validateDynamicWalletClaims(
      {
        sub: 'dynamic-user-1',
        scope: 'openid email',
        verified_credentials: [{ address: WALLET_ADDRESS }],
      },
      {
        dynamicUserId: 'dynamic-user-1',
        walletAddress: WALLET_ADDRESS,
      },
    );

    expect(result).toMatchObject({
      mode: 'verified',
      dynamicUserId: 'dynamic-user-1',
      verifiedCredentials: [{ address: WALLET_ADDRESS }],
    });
  });

  it('rejects tokens that require additional authentication', () => {
    expect(() => validateDynamicWalletClaims(
      {
        sub: 'dynamic-user-1',
        scopes: ['requiresAdditionalAuth'],
        verified_credentials: [{ address: WALLET_ADDRESS }],
      },
      {
        dynamicUserId: 'dynamic-user-1',
        walletAddress: WALLET_ADDRESS,
      },
    )).toThrow('Dynamic auth token requires additional authentication');
  });

  it('rejects tokens that do not verify the active wallet', () => {
    expect(() => validateDynamicWalletClaims(
      {
        sub: 'dynamic-user-1',
        verified_credentials: [{ address: 'OtherWallet111111111111111111111111111111' }],
      },
      {
        dynamicUserId: 'dynamic-user-1',
        walletAddress: WALLET_ADDRESS,
      },
    )).toThrow('Dynamic auth token does not verify the active wallet');
  });
});

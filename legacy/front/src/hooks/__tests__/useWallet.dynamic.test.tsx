// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logoutAppSession } from '@/lib/api/client';
import { useWallet } from '../useWallet';
import type { DynamicWalletRuntime } from '@/providers/dynamicWalletRuntime';

let dynamicRuntime: DynamicWalletRuntime | null = null;

vi.mock('@/providers/dynamicWalletRuntime', () => ({
  useDynamicWalletRuntime: () => dynamicRuntime,
}));

vi.mock('@dynamic-labs/sdk-react-core', () => ({
  getAuthToken: vi.fn(() => 'dynamic-test-token'),
}));

vi.mock('@/lib/api/client', () => ({
  createDynamicAppSession: vi.fn(() => Promise.resolve({ session_id: 'app-session-1' })),
  logoutAppSession: vi.fn(() => Promise.resolve()),
}));

vi.mock('../useWalletBalances', () => ({
  useWalletBalances: vi.fn(() => ({
    data: undefined,
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  })),
}));

function makeDynamicRuntime(overrides: Partial<DynamicWalletRuntime> = {}): DynamicWalletRuntime {
  return {
    isEnabled: true,
    isResolved: true,
    isConnected: true,
    isConnecting: false,
    address: 'DyNaMic111111111111111111111111111111111',
    walletType: 'embedded',
    walletProvider: 'dynamic',
    dynamicUserId: 'dyn-user-1',
    walletError: undefined,
    connect: vi.fn(),
    disconnect: vi.fn(),
    signAndSendTransaction: vi.fn(),
    exportWallet: vi.fn(),
    ...overrides,
  };
}

describe('useWallet Dynamic adapter', () => {
  beforeEach(() => {
    dynamicRuntime = null;
    vi.clearAllMocks();
  });

  it('exposes the active Dynamic embedded wallet state', () => {
    dynamicRuntime = makeDynamicRuntime();

    const { result } = renderHook(() => useWallet());

    expect(result.current.isConnected).toBe(true);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.isResolved).toBe(true);
    expect(result.current.address).toBe('DyNaMic111111111111111111111111111111111');
    expect(result.current.walletType).toBe('embedded');
    expect(result.current.walletProvider).toBe('dynamic');
    expect(result.current.dynamicUserId).toBe('dyn-user-1');
    expect(result.current.authStatus).toBe('verified');
    expect(result.current.exportWallet).toBe(dynamicRuntime.exportWallet);
  });

  it('exposes Dynamic wallet provisioning errors', () => {
    dynamicRuntime = makeDynamicRuntime({
      isConnected: false,
      address: undefined,
      walletType: undefined,
      walletError: 'No se pudo crear la embedded wallet Solana.',
    });

    const { result } = renderHook(() => useWallet());

    expect(result.current.walletError).toBe('No se pudo crear la embedded wallet Solana.');
  });

  it('opens Dynamic connect flow through the runtime', async () => {
    const connect = vi.fn();
    dynamicRuntime = makeDynamicRuntime({
      isConnected: false,
      address: undefined,
      walletType: undefined,
      connect,
    });

    const { result } = renderHook(() => useWallet());
    await result.current.connect();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('clears the app session before logging out of Dynamic', async () => {
    const disconnect = vi.fn(() => Promise.resolve());
    dynamicRuntime = makeDynamicRuntime({ disconnect });

    const { result } = renderHook(() => useWallet());
    await act(async () => {
      await result.current.disconnect();
    });

    expect(logoutAppSession).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects signing when the expected wallet address mismatches', async () => {
    dynamicRuntime = makeDynamicRuntime();

    const { result } = renderHook(() => useWallet());

    await expect(
      result.current.signAndSendPreparedTransaction('not-needed-for-mismatch', 'OtherWallet1111111111111111111111111111111'),
    ).rejects.toMatchObject({ code: 'wallet_mismatch' });
  });
});

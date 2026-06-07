import { createContext, useContext } from 'react';
import type { Transaction, VersionedTransaction } from '@solana/web3.js';
import type { AppWalletType } from '@/types/wallet';

export type DynamicWalletRuntime = {
  isEnabled: true;
  isResolved: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  address: string | undefined;
  walletType: AppWalletType | undefined;
  walletProvider: string | undefined;
  dynamicUserId: string | undefined;
  walletError: string | undefined;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  signAndSendTransaction: (transaction: Transaction | VersionedTransaction) => Promise<string>;
  exportWallet: (() => Promise<void>) | undefined;
};

export const DynamicWalletRuntimeContext = createContext<DynamicWalletRuntime | null>(null);

export function useDynamicWalletRuntime() {
  return useContext(DynamicWalletRuntimeContext);
}

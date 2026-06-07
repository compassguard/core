import type { GetBalancesResponse } from './api';

export type AppWalletType = 'external' | 'embedded';

export type AppWalletAuthStatus =
  | 'unknown'
  | 'connected'
  | 'verified'
  | 'unauthenticated';

export type WalletDisplayState = {
  isConnected: boolean;
  address?: string;
  walletType?: AppWalletType;
  walletProvider?: string;
  authStatus?: AppWalletAuthStatus;
  balances?: GetBalancesResponse;
};

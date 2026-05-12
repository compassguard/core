import type { GetBalancesResponse } from './api';

export type WalletDisplayState = {
  isConnected: boolean;
  address?: string;
  balances?: GetBalancesResponse;
};

import { AssetAllocationDonut } from '@/components/wallet/AssetAllocationDonut';
import { AssetList } from '@/components/wallet/AssetList';
import { BalanceCard } from '@/components/wallet/BalanceCard';
import { ConnectionStatus } from '@/components/status/ConnectionStatus';
import { useWallet } from '@/hooks/useWallet';

export function RightPanel() {
  const wallet = useWallet();

  return (
    <aside className="space-y-4">
      <BalanceCard data={wallet.balances} isLoading={wallet.isBalancesLoading} isError={Boolean(wallet.balancesError)} />
      <AssetAllocationDonut allocation={wallet.allocation} isLoading={wallet.isBalancesLoading} />
      <AssetList assets={wallet.balances?.balances} />
      <ConnectionStatus />
    </aside>
  );
}

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import type { AllocationItem } from '@/types/api';

const fallbackColors = ['#0052ff', '#16a34a', '#d97706', '#64748b', '#7c3aed'];

type AssetAllocationDonutProps = {
  allocation?: AllocationItem[];
  isLoading?: boolean;
};

export function AssetAllocationDonut({ allocation = [], isLoading = false }: AssetAllocationDonutProps) {
  if (isLoading) {
    return (
      <div className="rounded-2xl border border-outline bg-surface p-4 shadow-sm">
        <p className="mb-3 text-sm font-semibold text-on-surface">Allocation</p>
        <div className="h-44 animate-pulse rounded-2xl bg-surface-hover" />
      </div>
    );
  }

  if (allocation.length === 0) {
    return (
      <div className="rounded-2xl border border-outline bg-surface p-4 text-sm text-on-surface-variant">
        No allocation data
      </div>
    );
  }

  const total = allocation.reduce((acc, item) => acc + item.percentage, 0);

  return (
    <div className="rounded-2xl border border-outline bg-surface p-4 shadow-sm">
      <p className="mb-3 text-sm font-semibold text-on-surface">Allocation</p>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={allocation}
              dataKey="percentage"
              nameKey="symbol"
              innerRadius={48}
              outerRadius={72}
              paddingAngle={3}
              startAngle={90}
              endAngle={-270}
            >
              {allocation.map((item, index) => (
                <Cell key={item.symbol} fill={item.color ? `#${item.color.replace('#', '')}` : fallbackColors[index % fallbackColors.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(value) => `${Number(value).toFixed(1)}%`} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <p className="mb-2 text-xs text-on-surface-variant">Total: {total.toFixed(1)}%</p>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {allocation.map((item, index) => (
          <div key={item.symbol} className="flex items-center gap-2 text-xs text-on-surface-variant">
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color ? `#${item.color.replace('#', '')}` : fallbackColors[index % fallbackColors.length] }} />
            <span>{item.symbol}</span>
            <span className="ml-auto tabular-nums">{item.percentage.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

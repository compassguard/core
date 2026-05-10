import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import type { AllocationItem } from '@/types/api';

const fallbackColors = ['#0052ff', '#16a34a', '#d97706', '#64748b', '#7c3aed'];

export function AssetAllocationDonut({ allocation = [] }: { allocation?: AllocationItem[] }) {
  if (allocation.length === 0) {
    return <div className="rounded-2xl border border-outline bg-surface p-4 text-sm text-on-surface-variant">Sin assets</div>;
  }

  return (
    <div className="rounded-2xl border border-outline bg-surface p-4 shadow-sm">
      <p className="mb-3 text-sm font-semibold text-on-surface">Allocation</p>
      <div className="flex h-44 items-center justify-center">
        <PieChart width={280} height={176}>
          <Pie data={allocation} dataKey="percentage" nameKey="symbol" innerRadius={48} outerRadius={72} paddingAngle={3}>
            {allocation.map((item, index) => (
              <Cell key={item.symbol} fill={item.color ? `#${item.color.replace('#', '')}` : fallbackColors[index % fallbackColors.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => `${Number(value).toFixed(1)}%`} />
        </PieChart>
      </div>
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

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { SwapGuardWarning as SwapGuardWarningData } from '@/types/api';
import { GuardrailExplanationCard } from './GuardrailExplanationCard';

export function SwapGuardWarning({ warning }: { warning: SwapGuardWarningData }) {
  const deviationPercent = (warning.deviation_bps / 100).toFixed(1);

  if (warning.explanation) {
    return <GuardrailExplanationCard explanation={warning.explanation} className="mt-4" />;
  }

  return (
    <div className="mt-4 rounded-2xl border border-warning-border bg-warning-bg p-4 text-warning-text">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold">Precio poco favorable ({deviationPercent}% desviación)</p>
          <p className="mt-1 text-sm opacity-90">{warning.message}</p>
          <p className="mt-2 text-xs opacity-75">
            El precio cotizado difiere del precio de mercado según el oráculo Pyth.
            Puedes continuar, pero revisa si el precio es aceptable para ti.
          </p>
        </div>
      </div>
    </div>
  );
}

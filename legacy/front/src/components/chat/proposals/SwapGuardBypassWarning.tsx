import React from 'react';
import { useChatStore, type GuardRejectionState } from '@/stores/chatStore';
import { useAgentMessage } from '@/hooks/useAgentMessage';
import { GuardrailExplanationCard } from './GuardrailExplanationCard';

type Props = {
  guardRejection: NonNullable<GuardRejectionState>;
};

export function SwapGuardBypassWarning({ guardRejection }: Props) {
  const { approveProposal, rejectProposal } = useAgentMessage();
  const status = useChatStore((state) => state.status);

  const isExecuting = status === 'executing';
  const deviationPercent = (guardRejection.deviation_bps / 100).toFixed(2);
  const maxAllowedPercent = (guardRejection.max_allowed_bps / 100).toFixed(1);

  const handleBypass = () => {
    console.log('[SwapGuardBypassWarning] User accepted risk, bypassing guard');
    approveProposal(true);
  };

  const handleCancel = () => {
    console.log('[SwapGuardBypassWarning] User declined bypass, cancelling');
    rejectProposal();
  };

  return (
    <div className="rounded-lg border-2 border-yellow-500 bg-yellow-50 p-4 dark:border-yellow-600 dark:bg-yellow-900/20">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 text-2xl">&#9888;</div>
        <div className="flex-1">
          <h3 className="font-semibold text-yellow-800 dark:text-yellow-200">
            Guard de precio rechazó la transacción
          </h3>

          {guardRejection.explanation ? (
            <GuardrailExplanationCard explanation={guardRejection.explanation} className="mt-3" />
          ) : null}

          <div className="mt-2 space-y-2 text-sm text-yellow-700 dark:text-yellow-300">
            <p>
              El precio del swap difiere <strong>{deviationPercent}%</strong> del precio de mercado 
              (máximo permitido: {maxAllowedPercent}%).
            </p>
            
            <div className="rounded bg-yellow-100 p-2 dark:bg-yellow-800/30">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-yellow-600 dark:text-yellow-400">Precio cotizado:</span>{' '}
                  <strong>${guardRejection.quoted_price_usd.toFixed(2)}</strong>
                </div>
                <div>
                  <span className="text-yellow-600 dark:text-yellow-400">Precio oráculo:</span>{' '}
                  <strong>${guardRejection.oracle_price_usd.toFixed(2)}</strong>
                </div>
              </div>
            </div>
            
            <p className="text-yellow-600 dark:text-yellow-400">
              {guardRejection.warning_message}
            </p>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              onClick={handleCancel}
              disabled={isExecuting}
              className="flex-1 rounded-lg bg-gray-200 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              Cancelar
            </button>
            <button
              onClick={handleBypass}
              disabled={isExecuting}
              className="flex-1 rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
            >
              {isExecuting ? 'Procesando...' : 'Ejecutar sin protección'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

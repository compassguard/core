import { AlertTriangle, ShieldCheck } from 'lucide-react';
import type { RiskInfo } from '@/types/api';
import { useSettingsStore } from '@/stores/settingsStore';

type WalletSafetyReason = NonNullable<RiskInfo['walletSafety']>['reasons'][number];

function getUniqueReasons(reasons: WalletSafetyReason[] = []) {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = reason.code || reason.message;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function explainReason(reason: WalletSafetyReason): string {
  switch (reason.code) {
    case 'RECIPIENT_NOT_ALLOWLISTED_OVER_WARN_THRESHOLD':
      return 'Es un envío por encima del umbral de precaución a una wallet que no está en tu allowlist. Si la dirección fue copiada mal o pertenece a un tercero no esperado, el monto podría perderse.';
    case 'LOW_HISTORY':
      return 'Por política de seguridad, los envíos de monto elevado requieren una revisión extra antes de firmar.';
    case 'RECIPIENT_ACCOUNT_NOT_FOUND':
      return 'Atención: esta dirección no tiene cuenta creada ni historial on-chain visible en devnet. Es posible que la wallet no exista todavía o que nunca haya recibido fondos.';
    case 'RECIPIENT_EXECUTABLE':
      return 'El destino es una cuenta ejecutable o programa, no una wallet normal. Este tipo de transferencia queda bloqueada.';
    case 'RECIPIENT_BLOCKLISTED':
    case 'RECIPIENT_USER_DENYLISTED':
      return 'La wallet destino aparece en una lista de bloqueo configurada para evitar envíos a direcciones riesgosas.';
    case 'RECIPIENT_SANCTIONED':
    case 'RECIPIENT_CONFIRMED_ABUSE_MATCH':
      return 'La wallet destino coincide con una señal crítica externa o de abuso confirmado.';
    case 'RECIPIENT_NOT_INDEXED_ON_SOLSCAN':
      return 'Solscan no reporta a esta wallet como indexada; requiere revisión antes de continuar.';
    case 'PROVIDER_PARTIAL_FAILURE':
      return 'Falló una consulta de señal externa (Solscan). No se permite confirmación silenciosa.';
    case 'INVALID_PUBLIC_KEY':
      return 'La dirección ingresada no es una public key válida de Solana.';
    case 'USER_POLICY_TRANSFER_LIMIT_EXCEEDED':
      return 'El monto supera el límite máximo configurado para transferencias.';
    case 'ACTION_HASH_MISMATCH':
      return 'La propuesta cambió desde que fue creada; se bloquea para evitar firmar parámetros distintos.';
    default:
      return reason.message;
  }
}

function buildCheckSummary(risk: RiskInfo): string[] {
  const checks = new Set<string>();
  const sources = risk.walletSafety?.sources ?? [];
  const accountNotFound = risk.walletSafety?.reasons.some(
    (reason) => reason.code === 'RECIPIENT_ACCOUNT_NOT_FOUND',
  );

  if (risk.walletSafety) {
    checks.add('Dirección de Solana válida.');
  }

  if (accountNotFound) {
    checks.add('Solana RPC confirmó que no hay una cuenta creada para esta dirección en devnet.');
  } else if (sources.some((source) => source.provider === 'solana-rpc' && source.status === 'ok')) {
    checks.add('Cuenta consultada en Solana RPC.');
  } else if (sources.some((source) => source.provider === 'solana-rpc' && source.status === 'error')) {
    checks.add('La consulta a Solana RPC falló; por eso no se aprueba silenciosamente.');
  }

  if (sources.some((source) => source.provider === 'internal-list' || source.provider === 'internal')) {
    checks.add('Listas internas revisadas.');
  }
  const solscanStatus = sources.find((source) => source.provider === 'solscan');
  if (solscanStatus) {
    if (solscanStatus.status === 'ok') {
      checks.add('Solscan respondió estado indexado para la wallet destino.');
    } else if (solscanStatus.status === 'missing') {
      checks.add('Solscan no encontró evidencia indexada de la wallet destino.');
    } else if (solscanStatus.status === 'error') {
      checks.add('La consulta a Solscan falló o está tardando; por eso se mantiene en riesgo.');
    }
  }

  for (const reason of risk.reasons ?? []) {
    if (!reason.includes(':') && reason !== 'Dirección de destino con formato Solana válido') {
      checks.add(reason.endsWith('.') ? reason : `${reason}.`);
    }
  }

  return Array.from(checks);
}

export function RiskInlineAlert({ risk }: { risk: RiskInfo }) {
  const enabled = useSettingsStore((state) => state.riskWarningsEnabled);
  if (!enabled) return null;

  const walletDecision = risk.walletSafety?.decision;
  const explainedReasons = getUniqueReasons(risk.walletSafety?.reasons).map(explainReason);
  const checkSummary = buildCheckSummary(risk);

  if (walletDecision === 'REJECT') {
    return (
      <div className="mt-4 rounded-2xl border border-error-border bg-error-bg p-4 text-error-text">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5" />
          <div>
            <p className="text-sm font-semibold">Transferencia bloqueada por seguridad</p>
            {explainedReasons.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
                {explainedReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  if (risk.level === 'low' && walletDecision !== 'WARN') {
    return (
      <div className="mt-4 rounded-xl border border-success/20 bg-success-bg p-4 text-success">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5" />
          <div>
            <p className="text-sm font-semibold">Riesgo bajo · {risk.score}/100</p>
            {checkSummary.length ? (
              <div className="mt-3 border-t border-current/20 pt-3 text-xs">
                <p className="font-semibold">Chequeos realizados</p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  {checkSummary.map((check) => (
                    <li key={check}>{check}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const critical = risk.level === 'critical';
  const warningClass = walletDecision === 'WARN' ? 'border-warning-border bg-warning-bg text-warning-text' : 'border-warning-border bg-warning-bg text-warning-text';
  const warningLabel = walletDecision === 'WARN' ? 'Revisá antes de firmar' : critical ? 'Riesgo crítico' : 'Advertencia de riesgo';
  return (
    <div className={`mt-4 rounded-2xl border p-4 ${warningClass} ${critical ? 'border-error-border bg-error-bg text-error-text' : ''}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5" />
        <div>
          <p className="text-sm font-semibold">
            {warningLabel} · {risk.score}/100
          </p>
          {walletDecision === 'WARN' ? (
            <p className="mt-1 text-sm">
              No encontramos un bloqueo duro, pero esta transferencia necesita confirmación reforzada.
            </p>
          ) : null}
          {explainedReasons.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
              {explainedReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}
          {checkSummary.length ? (
            <div className="mt-3 border-t border-current/20 pt-3 text-xs">
              <p className="font-semibold">Chequeos realizados</p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {checkSummary.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

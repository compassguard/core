import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { GuardrailDecision, GuardrailExplanation, GuardrailSeverity, SuggestedUserAction } from '@/types/api';

type GuardrailExplanationCardProps = {
  explanation: GuardrailExplanation;
  defaultExpanded?: boolean;
  showTechnicalDetails?: boolean;
  className?: string;
};

const decisionLabels: Record<GuardrailDecision, string> = {
  ALLOW: 'ALLOW · Permitido',
  WARN: 'WARN · Revisá antes de firmar',
  REJECT: 'REJECT · Bloqueado por seguridad',
};

const severityStyles: Record<GuardrailSeverity, string> = {
  info: 'border-success/20 bg-success-bg text-success',
  warning: 'border-warning-border bg-warning-bg text-warning-text',
  critical: 'border-error-border bg-error-bg text-error-text',
};

const checkStatusLabels = {
  pass: 'OK',
  warn: 'Advertencia',
  fail: 'Falla',
  error: 'Error',
  not_run: 'No ejecutado',
} as const;

const sourceStatusLabels = {
  ok: 'OK',
  missing: 'Sin datos',
  stale: 'Desactualizado',
  error: 'Error',
} as const;

const suggestedActionLabels: Record<SuggestedUserAction, string> = {
  continue: 'Podés continuar si reconocés la operación.',
  cancel: 'Cancelá la operación.',
  review_destination: 'Revisá que la dirección destino sea correcta.',
  reduce_amount: 'Reducí el monto antes de continuar.',
  send_test_amount: 'Mandá primero un monto de prueba.',
  review_price: 'Revisá el precio cotizado antes de firmar.',
  adjust_slippage: 'Ajustá el slippage y volvé a cotizar.',
  wait_and_retry: 'Esperá y reintentá cuando las señales estén sanas.',
  request_review: 'Pedí revisión adicional antes de continuar.',
};

function classNames(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function DecisionIcon({ severity }: { severity: GuardrailSeverity }) {
  if (severity === 'info') return <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0" />;
  if (severity === 'critical') return <ShieldAlert className="mt-0.5 h-5 w-5 flex-shrink-0" />;
  return <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function GuardrailExplanationCard({
  explanation,
  defaultExpanded = false,
  showTechnicalDetails = false,
  className,
}: GuardrailExplanationCardProps) {
  const [detailsExpanded, setDetailsExpanded] = useState(defaultExpanded);
  const [technicalExpanded, setTechnicalExpanded] = useState(showTechnicalDetails);
  const hasDetails = explanation.reasons.length > 0 || explanation.checks.length > 0 || explanation.sources.length > 0;
  const technicalEntries = Object.entries(explanation.technical_details ?? {});
  const hasTechnicalDetails = technicalEntries.length > 0;
  const detailsId = `${explanation.id}-guardrail-details`;
  const technicalId = `${explanation.id}-guardrail-technical-details`;

  return (
    <section
      className={classNames('rounded-2xl border p-4', severityStyles[explanation.severity], className)}
      aria-label="Explicación del guardrail"
    >
      <div className="flex items-start gap-3">
        <DecisionIcon severity={explanation.severity} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{decisionLabels[explanation.decision]}</p>
            <span className="rounded-full border border-current/20 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide opacity-80">
              {explanation.category.replaceAll('_', ' ')}
            </span>
          </div>

          <p className="mt-1 text-sm opacity-95">{explanation.summary}</p>
          {explanation.impact ? <p className="mt-2 text-sm opacity-90">{explanation.impact}</p> : null}
          {explanation.suggested_user_action ? (
            <p className="mt-2 text-xs font-medium opacity-90">{suggestedActionLabels[explanation.suggested_user_action]}</p>
          ) : null}

          {explanation.narration ? (
            <aside className="mt-3 rounded-xl border border-current/15 bg-current/5 p-3 text-xs" aria-label="Ayuda narrativa del guardrail">
              <p className="font-semibold">Ayuda contextual</p>
              <p className="mt-1 opacity-90">{explanation.narration.summary}</p>
              {explanation.narration.bullets?.length ? (
                <ul className="mt-2 list-disc space-y-1 pl-4 opacity-90">
                  {explanation.narration.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 opacity-70">Narrativa derivada del payload estructurado; la decisión oficial es la de arriba.</p>
            </aside>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {hasDetails ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-current/20 px-3 py-1 text-xs font-semibold hover:bg-current/5"
                aria-expanded={detailsExpanded}
                aria-controls={detailsId}
                onClick={() => setDetailsExpanded((value) => !value)}
              >
                {detailsExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {detailsExpanded ? 'Ocultar detalles' : 'Ver detalles'}
              </button>
            ) : null}
            {hasTechnicalDetails ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-current/20 px-3 py-1 text-xs font-semibold hover:bg-current/5"
                aria-expanded={technicalExpanded}
                aria-controls={technicalId}
                onClick={() => setTechnicalExpanded((value) => !value)}
              >
                {technicalExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {technicalExpanded ? 'Ocultar técnico' : 'Ver técnico'}
              </button>
            ) : null}
          </div>

          {detailsExpanded && hasDetails ? (
            <div id={detailsId} className="mt-3 space-y-3 border-t border-current/20 pt-3 text-xs">
              {explanation.reasons.length ? (
                <div>
                  <p className="font-semibold">Razones</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {explanation.reasons.map((reason) => (
                      <li key={`${reason.code}-${reason.source}`}>
                        <span className="font-medium">{reason.code}</span>: {reason.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {explanation.checks.length ? (
                <div>
                  <p className="font-semibold">Chequeos</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {explanation.checks.map((check) => (
                      <li key={check.check}>
                        {check.label} <span className="opacity-75">({checkStatusLabels[check.status]} · {check.source})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {explanation.sources.length ? (
                <div>
                  <p className="font-semibold">Fuentes</p>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {explanation.sources.map((source) => (
                      <li key={`${source.provider}-${source.status}-${source.checked_at ?? 'unchecked'}`}>
                        {source.provider}: {sourceStatusLabels[source.status]}
                        {source.checked_at ? <span className="opacity-75"> · {source.checked_at}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}

          {technicalExpanded && hasTechnicalDetails ? (
            <div id={technicalId} className="mt-3 border-t border-current/20 pt-3 text-xs">
              <p className="font-semibold">Detalles técnicos</p>
              <dl className="mt-2 space-y-2">
                {technicalEntries.map(([key, value]) => (
                  <div key={key} className="rounded-lg border border-current/10 bg-current/5 p-2">
                    <dt className="font-mono text-[11px] font-semibold">{key}</dt>
                    <dd className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] opacity-85">{formatValue(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

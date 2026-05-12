import { getEnv, jsonResponse, passthrough } from './upstream';

export async function proxyRiskScore(mint: string | null) {
  const apiUrl = getEnv('RISK_SCORE_API_URL', 'VITE_RISK_SCORE_API_URL');
  if (!apiUrl) {
    return jsonResponse({ error: 'RISK_SCORE_API_URL_NOT_CONFIGURED' }, { status: 503 });
  }

  if (!mint) {
    return jsonResponse({ error: 'MISSING_MINT' }, { status: 400 });
  }

  const apiKey = getEnv('RISK_SCORE_API_KEY', 'VITE_RISK_SCORE_API_KEY');
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/risk?mint=${encodeURIComponent(mint)}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    cache: 'no-store',
  });

  return passthrough(response);
}

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifyDynamicWalletAuth } from './dynamic';

export type AppWalletType = 'external' | 'embedded';

export type AuthenticatedWalletIdentity = {
  sessionId: string;
  dynamicUserId?: string;
  walletAddress: string;
  walletType: AppWalletType;
  walletProvider?: string;
  verifiedAt: string;
  verificationMode: 'verified' | 'development' | 'session';
};

export type AppSessionClaims = {
  sessionId: string;
  dynamicUserId?: string;
  walletAddress: string;
  walletType: AppWalletType;
  walletProvider?: string;
  verifiedAt: string;
  issuedAt: number;
  expiresAt: number;
  verificationMode: 'verified' | 'development';
};

export type CreateDynamicAppSessionInput = {
  dynamicUserId?: string;
  walletAddress: string;
  walletType: AppWalletType;
  walletProvider?: string;
  dynamicAuthToken?: string;
};

export const APP_SESSION_COOKIE_NAME = 'compass_app_session';

const APP_SESSION_TTL_SECONDS = 60 * 60 * 8;

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function getSessionSecret(): string {
  const configured = process.env.APP_SESSION_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_SESSION_SECRET is required in production');
  }
  return 'development-only-compass-app-session-secret';
}

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', getSessionSecret()).update(encodedPayload).digest('base64url');
}

function toToken(claims: AppSessionClaims): string {
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

function fromToken(token: string): AppSessionClaims | null {
  const [encodedPayload, signature, ...extra] = token.split('.');
  if (!encodedPayload || !signature || extra.length > 0) return null;

  const expected = signPayload(encodedPayload);
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) {
    return null;
  }

  let claims: AppSessionClaims;
  try {
    claims = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as AppSessionClaims;
  } catch {
    return null;
  }

  if (!claims.sessionId || !claims.walletAddress || !claims.walletType || !claims.expiresAt) return null;
  if (Date.now() >= claims.expiresAt) return null;

  return claims;
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const separatorIndex = entry.indexOf('=');
        if (separatorIndex === -1) return [entry, ''];
        const key = entry.slice(0, separatorIndex);
        const value = entry.slice(separatorIndex + 1);
        return [key, decodeURIComponent(value)];
      }),
  );
}

function appendCookieAttributes(value: string, maxAgeSeconds: number): string {
  const attributes = [
    `${APP_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (process.env.NODE_ENV === 'production') {
    attributes.push('Secure');
  }

  return attributes.join('; ');
}

export function buildAppSessionSetCookie(token: string): string {
  return appendCookieAttributes(token, APP_SESSION_TTL_SECONDS);
}

export function buildAppSessionClearCookie(): string {
  return appendCookieAttributes('', 0);
}

export async function createDynamicAppSession(input: CreateDynamicAppSessionInput): Promise<{
  identity: AuthenticatedWalletIdentity;
  token: string;
  claims: AppSessionClaims;
}> {
  const walletAddress = input.walletAddress.trim();
  if (!walletAddress) throw new Error('walletAddress is required');
  if (input.walletType !== 'external' && input.walletType !== 'embedded') {
    throw new Error('walletType must be external or embedded');
  }

  const verification = await verifyDynamicWalletAuth({
    authToken: input.dynamicAuthToken,
    dynamicUserId: input.dynamicUserId,
    walletAddress,
  });

  const now = Date.now();
  const claims: AppSessionClaims = {
    sessionId: randomUUID(),
    dynamicUserId: verification.dynamicUserId || input.dynamicUserId,
    walletAddress,
    walletType: input.walletType,
    walletProvider: input.walletProvider,
    verifiedAt: new Date(now).toISOString(),
    issuedAt: now,
    expiresAt: now + APP_SESSION_TTL_SECONDS * 1000,
    verificationMode: verification.mode,
  };

  const token = toToken(claims);
  return {
    token,
    claims,
    identity: toAuthenticatedWalletIdentity(claims, claims.verificationMode),
  };
}

export function toAuthenticatedWalletIdentity(
  claims: AppSessionClaims,
  verificationMode: AuthenticatedWalletIdentity['verificationMode'] = 'session',
): AuthenticatedWalletIdentity {
  return {
    sessionId: claims.sessionId,
    dynamicUserId: claims.dynamicUserId,
    walletAddress: claims.walletAddress,
    walletType: claims.walletType,
    walletProvider: claims.walletProvider,
    verifiedAt: claims.verifiedAt,
    verificationMode,
  };
}

export function getAppSessionFromRequest(request: Request): AuthenticatedWalletIdentity | null {
  const cookies = parseCookies(request.headers.get('cookie'));
  const token = cookies[APP_SESSION_COOKIE_NAME];
  if (!token) return null;

  const claims = fromToken(token);
  return claims ? toAuthenticatedWalletIdentity(claims, 'session') : null;
}

export function isAppSessionRequired(): boolean {
  if (process.env.REQUIRE_APP_SESSION === 'true') return true;
  if (process.env.NODE_ENV === 'production') return true;
  return Boolean(process.env.DYNAMIC_ENVIRONMENT_ID?.trim() || process.env.APP_SESSION_SECRET?.trim());
}

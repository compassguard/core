import { createPublicKey, createVerify } from 'node:crypto';

export type DynamicVerifiedCredential = {
  address?: string;
  publicIdentifier?: string;
  walletName?: string;
  walletProvider?: string;
  chain?: string;
  chainName?: string;
  format?: string;
  id?: string;
};

export type DynamicJwtClaims = {
  sub?: string;
  iss?: string;
  exp?: number;
  iat?: number;
  scope?: string | string[];
  scopes?: string | string[];
  verified_credentials?: DynamicVerifiedCredential[];
  verifiedCredentials?: DynamicVerifiedCredential[];
  [key: string]: unknown;
};

export type DynamicVerificationResult = {
  mode: 'verified' | 'development';
  dynamicUserId?: string;
  verifiedCredentials: DynamicVerifiedCredential[];
};

type JwksKey = JsonWebKey & {
  kid?: string;
  alg?: string;
  use?: string;
};

type JwksResponse = {
  keys?: JwksKey[];
};

const JWKS_CACHE = new Map<string, { expiresAt: number; keys: JwksKey[] }>();
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function parseJwtSegment<T>(segment: string): T {
  return JSON.parse(base64UrlDecode(segment).toString('utf8')) as T;
}

function getScopes(claims: DynamicJwtClaims): string[] {
  const rawScopes = claims.scopes ?? claims.scope;
  if (Array.isArray(rawScopes)) return rawScopes.filter((scope): scope is string => typeof scope === 'string');
  if (typeof rawScopes === 'string') return rawScopes.split(' ').filter(Boolean);
  return [];
}

function getVerifiedCredentials(claims: DynamicJwtClaims): DynamicVerifiedCredential[] {
  const credentials = claims.verified_credentials ?? claims.verifiedCredentials;
  return Array.isArray(credentials) ? credentials : [];
}

function credentialMatchesWallet(credential: DynamicVerifiedCredential, walletAddress: string): boolean {
  const expected = walletAddress.trim();
  return credential.address === expected || credential.publicIdentifier === expected;
}

async function getJwks(environmentId: string): Promise<JwksKey[]> {
  const cached = JWKS_CACHE.get(environmentId);
  if (cached && Date.now() < cached.expiresAt) return cached.keys;

  const response = await fetch(`https://app.dynamic.xyz/api/v0/sdk/${encodeURIComponent(environmentId)}/.well-known/jwks`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Dynamic JWKS request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as JwksResponse;
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  JWKS_CACHE.set(environmentId, { expiresAt: Date.now() + JWKS_CACHE_TTL_MS, keys });
  return keys;
}

async function verifyJwtSignature(authToken: string, environmentId: string): Promise<DynamicJwtClaims> {
  const parts = authToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid Dynamic auth token');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJwtSegment<{ alg?: string; kid?: string }>(encodedHeader);
  if (header.alg !== 'RS256') throw new Error('Unsupported Dynamic auth token algorithm');

  const keys = await getJwks(environmentId);
  const jwk = keys.find((key) => !header.kid || key.kid === header.kid);
  if (!jwk) throw new Error('Dynamic JWKS signing key not found');

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const isValid = verifier.verify(publicKey, base64UrlDecode(encodedSignature));
  if (!isValid) throw new Error('Invalid Dynamic auth token signature');

  const claims = parseJwtSegment<DynamicJwtClaims>(encodedPayload);
  if (claims.exp && Date.now() >= claims.exp * 1000) throw new Error('Dynamic auth token expired');

  return claims;
}

export function validateDynamicWalletClaims(
  claims: DynamicJwtClaims,
  input: {
    dynamicUserId?: string;
    walletAddress: string;
  },
): DynamicVerificationResult {
  const scopes = getScopes(claims);
  if (scopes.includes('requiresAdditionalAuth')) {
    throw new Error('Dynamic auth token requires additional authentication');
  }

  const verifiedCredentials = getVerifiedCredentials(claims);
  const walletVerified = verifiedCredentials.some((credential) => credentialMatchesWallet(credential, input.walletAddress));
  if (!walletVerified) {
    throw new Error('Dynamic auth token does not verify the active wallet');
  }

  if (input.dynamicUserId && claims.sub && input.dynamicUserId !== claims.sub) {
    throw new Error('Dynamic user id mismatch');
  }

  return {
    mode: 'verified',
    dynamicUserId: claims.sub || input.dynamicUserId,
    verifiedCredentials,
  };
}

export async function verifyDynamicWalletAuth(input: {
  authToken?: string;
  dynamicUserId?: string;
  walletAddress: string;
}): Promise<DynamicVerificationResult> {
  const environmentId = process.env.DYNAMIC_ENVIRONMENT_ID?.trim() || process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!environmentId || !input.authToken) {
    if (isProduction) {
      throw new Error('Dynamic auth token and environment id are required');
    }

    return {
      mode: 'development',
      dynamicUserId: input.dynamicUserId,
      verifiedCredentials: [{ address: input.walletAddress }],
    };
  }

  const claims = await verifyJwtSignature(input.authToken, environmentId);
  return validateDynamicWalletClaims(claims, input);
}

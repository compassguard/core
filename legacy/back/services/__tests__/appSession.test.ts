import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_SESSION_COOKIE_NAME,
  buildAppSessionClearCookie,
  buildAppSessionSetCookie,
  createDynamicAppSession,
  getAppSessionFromRequest,
} from '../auth/appSession';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe('appSession', () => {
  it('creates and verifies a signed app session cookie in development mode', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.DYNAMIC_ENVIRONMENT_ID;
    delete process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID;
    process.env.APP_SESSION_SECRET = 'test-session-secret';

    const session = await createDynamicAppSession({
      dynamicUserId: 'dynamic-user-1',
      walletAddress: 'Wallet1111111111111111111111111111111111',
      walletType: 'embedded',
      walletProvider: 'dynamic',
    });

    const request = new Request('http://localhost/api/auth/session', {
      headers: {
        cookie: buildAppSessionSetCookie(session.token),
      },
    });

    expect(getAppSessionFromRequest(request)).toMatchObject({
      dynamicUserId: 'dynamic-user-1',
      walletAddress: 'Wallet1111111111111111111111111111111111',
      walletType: 'embedded',
      walletProvider: 'dynamic',
    });
  });

  it('clears the app session cookie with max-age zero', () => {
    expect(buildAppSessionClearCookie()).toContain(`${APP_SESSION_COOKIE_NAME}=`);
    expect(buildAppSessionClearCookie()).toContain('Max-Age=0');
  });
});

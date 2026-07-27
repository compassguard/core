import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /', () => {
  it('returns the API status instead of the removed landing file', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    await expect(response.json()).resolves.toEqual({
      service: 'Compass Guard API',
      status: 'ok',
      message: 'Compass Guard API is running.',
      documentation: 'https://docs.compassguard.xyz',
      health: '/health',
      apiVersion: 'v1',
    });
    expect(existsSync('landing.html')).toBe(false);
  });
});

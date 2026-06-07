import { afterEach, describe, expect, it } from 'vitest';

import { getAzureResponsesConfig } from '../azureResponsesClient';

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_CHAT_MODEL;
  delete process.env.OPENAI_RESPONSES_ENDPOINT;
  delete process.env.OPENAI_API_URL;
  delete process.env.AZURE_OPENAI_API_VERSION;
}

describe('getAzureResponsesConfig', () => {
  afterEach(() => {
    resetEnv();
  });

  it('uses explicit model and Responses endpoint from environment', () => {
    resetEnv();
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_CHAT_MODEL = 'test-model';
    process.env.OPENAI_RESPONSES_ENDPOINT = 'https://example.test/openai/responses?api-version=2025-04-01-preview';

    expect(getAzureResponsesConfig()).toEqual({
      apiKey: 'test-key',
      model: 'test-model',
      endpoint: 'https://example.test/openai/responses?api-version=2025-04-01-preview',
    });
  });

  it('builds endpoint from legacy base URL fallback', () => {
    resetEnv();
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_CHAT_MODEL = 'test-model';
    process.env.OPENAI_API_URL = 'https://example.test/openai/';
    process.env.AZURE_OPENAI_API_VERSION = '2026-01-01-preview';

    expect(getAzureResponsesConfig()).toEqual({
      apiKey: 'test-key',
      model: 'test-model',
      endpoint: 'https://example.test/openai/responses?api-version=2026-01-01-preview',
    });
  });

  it('requires the model to be configured', () => {
    resetEnv();
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_RESPONSES_ENDPOINT = 'https://example.test/openai/responses';

    expect(() => getAzureResponsesConfig()).toThrow('OPENAI_CHAT_MODEL not configured');
  });
});

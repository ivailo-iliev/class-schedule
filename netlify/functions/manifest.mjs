import { handleManifestRequest } from '../lib/manifest.mjs';

export async function handler(event) {
  return handleManifestRequest({
    method: event.httpMethod,
    headers: event.headers,
    queryStringParameters: event.queryStringParameters,
  });
}

export const config = {
  path: '/manifest.webmanifest',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

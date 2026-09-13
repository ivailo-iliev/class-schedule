import { handleManifestRequest } from '../lib/manifest.mjs';

export async function handler(event) {
  return handleManifestRequest({
    method: event.httpMethod,
    headers: event.headers,
    queryStringParameters: event.queryStringParameters,
  });
}

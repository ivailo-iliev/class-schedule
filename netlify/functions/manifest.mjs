import { handleManifestRequest } from '../lib/manifest.mjs';

function toResponse(result) {
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const result = await handleManifestRequest({
    method: req.method,
    headers: Object.fromEntries(req.headers),
    queryStringParameters: Object.fromEntries(url.searchParams),
  });
  return toResponse(result);
}

export const config = {
  path: '/manifest.webmanifest',
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

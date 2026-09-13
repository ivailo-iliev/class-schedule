import { handleProfileRequest } from '../lib/profile.mjs';

function toResponse(result) {
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export default async (req) => toResponse(await handleProfileRequest({
  method: req.method,
  headers: Object.fromEntries(req.headers),
}));

export const config = {
  rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

import { handleAccessRequest } from '../lib/access.mjs';

function toResponse(result) {
  return new Response(result.body, {
    status: result.status,
    headers: result.headers,
  });
}

export default async (req) => {
  const headers = Object.fromEntries(req.headers);
  const clientIp = req.headers.get('x-nf-client-connection-ip') ?? undefined;
  const result = await handleAccessRequest({
    method: req.method,
    headers,
    body: await req.text(),
    clientIp,
  });
  return toResponse(result);
}

export const config = {
  path: '/api/access',
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ['ip', 'domain'] },
};

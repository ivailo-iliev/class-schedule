import { handleAccessRequest } from '../lib/access.mjs';

export async function handler(event) {
  const clientIp = Object.entries(event.headers ?? {})
    .find(([name]) => name.toLowerCase() === 'x-nf-client-connection-ip')?.[1];
  return handleAccessRequest({
    method: event.httpMethod,
    headers: event.headers,
    body: event.body,
    clientIp,
  });
}

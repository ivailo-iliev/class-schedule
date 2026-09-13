import { handleAccessRequest } from '../lib/access.mjs';

export async function handler(event) {
  return handleAccessRequest({
    method: event.httpMethod,
    headers: event.headers,
    body: event.body,
  });
}

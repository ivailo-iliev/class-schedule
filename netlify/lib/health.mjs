const HEALTH_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'private, no-store',
};

export async function handleHealthRequest(request) {
  const method = String(request?.method ?? '').toUpperCase();
  const status = method === 'GET' || method === 'HEAD' ? 200 : 405;
  const body = status === 200 ? { status: 'ok' } : { error: 'method_not_allowed' };

  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...HEALTH_HEADERS,
      ...(status === 405 ? { allow: 'GET, HEAD' } : {}),
    },
  });
}

export default handleHealthRequest;

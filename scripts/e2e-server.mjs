import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { createServer as createViteServer } from 'vite';
import { handleAccessRequest } from '../netlify/lib/access.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const output = execFileSync('supabase', ['status', '--output', 'env'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
});
const local = Object.fromEntries(output.split(/\r?\n/)
  .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
  .filter((match) => match)
  .map((match) => [match[1], match[2].replace(/^"|"$/g, '')]));
const port = Number(process.env.PORT ?? 4173);
const origin = `http://localhost:${port}`;
const env = {
  ...process.env,
  APP_ORIGIN: origin,
  SUPABASE_URL: local.API_URL,
  SUPABASE_SECRET_API_KEY: local.SERVICE_ROLE_KEY,
  VITE_SUPABASE_URL: local.API_URL,
  VITE_SUPABASE_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
};
Object.assign(process.env, env);

function headersOf(request) {
  return Object.fromEntries(Object.entries(request.headers ?? {})
    .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? '']));
}

function sendResult(response, result) {
  response.writeHead(result.status, result.headers);
  response.end(result.body);
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const vite = await createViteServer({
  root,
  appType: 'spa',
  server: { middlewareMode: true },
});
const server = createHttpServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', origin);
    const headers = headersOf(request);
    if (url.pathname === '/api/access') {
      const result = await handleAccessRequest({
        method: request.method,
        headers,
        body: await readBody(request),
        clientIp: headers['x-nf-client-connection-ip'] ?? request.socket.remoteAddress,
      }, { env, fetchImpl: fetch });
      sendResult(response, result);
      return;
    }
    vite.middlewares(request, response);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? error.message : 'server_error');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`e2e server ready at ${origin}\n`);
});

const shutdown = async () => {
  await vite.close();
  server.close();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

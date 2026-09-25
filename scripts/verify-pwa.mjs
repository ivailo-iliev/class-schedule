import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { chromium, webkit } from '@playwright/test';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('could not allocate a preview port'));
        return;
      }
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], {
  stdio: 'ignore',
});

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('preview server did not start');
}

async function verify(browserType, name) {
  const browser = await browserType.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/access`, { waitUntil: 'networkidle' });
    assert.equal(response?.status(), 200, `${name}: SPA shell should load`);
    const manifestLink = page.locator('link[rel="manifest"]');
    assert.equal(await manifestLink.getAttribute('href'), '/manifest.webmanifest', `${name}: static manifest link`);
    const manifest = await (await page.request.get(`${origin}/manifest.webmanifest`)).json();
    assert.deepEqual(manifest, JSON.parse(await readFile('public/manifest.webmanifest', 'utf8')),
      `${name}: manifest should be served unchanged`);
    assert.equal(await page.evaluate(async () =>
      'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0), 0,
      `${name}: no service workers are registered by the app`);
    assert.equal(await page.evaluate(async () => (await caches.keys()).length), 0,
      `${name}: app should not create cache entries`);
    await context.close();
    console.log(`${name}: static manifest and no service-worker cache passed`);
  } finally {
    await browser.close();
  }
}

try {
  await waitForServer();
  await verify(chromium, 'Chromium 390x844');
  await verify(webkit, 'WebKit 390x844');
} finally {
  server.kill('SIGTERM');
}

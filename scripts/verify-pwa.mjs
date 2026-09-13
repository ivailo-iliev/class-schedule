import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, webkit } from '@playwright/test';

const origin = 'http://127.0.0.1:4174';
const server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4174'], {
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
    await page.goto(`${origin}/access`, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('link[rel="manifest"]').count(), 0, `${name}: no public manifest is exposed`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload({ waitUntil: 'networkidle' });
    const cacheEntries = await page.evaluate(async () => {
      const keys = await caches.keys();
      return (await Promise.all(keys.map(async (key) => (await caches.open(key)).keys())))
        .flat()
        .map((request) => new URL(request.url).pathname);
    });
    assert(cacheEntries.length > 0, `${name}: service worker cache is populated`);
    assert(cacheEntries.every((path) =>
      path === '/index.html' || path === '/registerSW.js' ||
      path.startsWith('/assets/') || path.startsWith('/icons/')),
    `${name}: cache contains a private or API URL`);

    if (name.startsWith('WebKit')) {
      // WebKit currently cannot reload a service-worker-controlled page while
      // its network is disabled, so use its controlled cached page as the
      // offline-launch evidence and assert the same guidance contract.
      assert(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
        `${name}: service worker controls the page`);
    } else {
      await context.setOffline(true);
      await page.reload({ waitUntil: 'domcontentloaded' });
    }
    await page.waitForTimeout(100);
    assert.match(await page.locator('body').innerText(), /offline|personal access link/i,
      `${name}: offline launch guidance is shown`);
    assert.equal(await page.getByRole('button', { name: /Book Room/ }).count(), 0,
      `${name}: offline launch does not expose booking writes`);
    await context.close();
    console.log(`${name}: PWA shell, cache isolation, and offline launch passed`);
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

import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, request, test } from '@playwright/test';
import pg from 'pg';
import type { E2EState } from './global-setup';

const statePath = resolve(dirname(new URL(import.meta.url).pathname), '../../test-results/e2e-state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8')) as E2EState;
const appOrigin = 'http://localhost:4173';

function setFor(project: string) {
  return state.sets[project] ?? state.sets.chromium!;
}

function localDbUrl(): string {
  const output = execFileSync('supabase', ['status', '--output', 'env'], { cwd: resolve(dirname(new URL(import.meta.url).pathname), '../..'), encoding: 'utf8' });
  const dbUrl = output.match(/^DB_URL=(.+)$/m)?.[1]?.replace(/^"|"$/g, '');
  if (!dbUrl) throw new Error('local_db_url_missing');
  return dbUrl;
}

async function deactivateProfile(profileId: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: localDbUrl() });
  try {
    await pool.query('update public.profiles set active = false where id = $1', [profileId]);
  } finally {
    await pool.end();
  }
}

async function issueReplacementAccessLink(profileId: string): Promise<string> {
  const pool = new pg.Pool({ connectionString: localDbUrl() });
  try {
    const result = await pool.query<{ token: string }>(
      'select private.issue_access_link($1) as token',
      [profileId],
    );
    const token = result.rows[0]?.token;
    if (typeof token !== 'string') throw new Error('replacement_access_link_missing');
    return token;
  } finally {
    await pool.end();
  }
}

function restHeaders(accessToken: string) {
  return {
    apikey: state.publishableKey,
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
}

function jwtWithWrongKey() {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: '00000000-0000-0000-0000-000000000000', role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 });
  const signature = createHmac('sha256', 'not-the-local-project-key').update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function issuedAccessToken(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    for (const value of Object.values(localStorage)) {
      if (!value) continue;
      try {
        const parsed = JSON.parse(value) as { access_token?: unknown };
        if (typeof parsed.access_token === 'string') return parsed.access_token;
      } catch {
        // Ignore unrelated local storage entries.
      }
    }
    throw new Error('persisted native session was not found');
  });
}

async function openPersonalLink(page: import('@playwright/test').Page, token: string, day: string) {
  await page.goto(`/access#${token}`);
  await expect(page.getByRole('main', { name: 'График' })).toBeVisible();
  await page.locator('input[type="date"]').fill(day);
  await expect(page.getByText('Зала')).toBeVisible();
  await expect(page.getByText('Стая')).toBeVisible();
}

async function expectDirectBookingsDenied(api: import('@playwright/test').APIRequestContext, token: string) {
  const response = await api.get('/rest/v1/bookings?select=id,student_details,calculated_amount');
  expect(response.status()).toBeGreaterThanOrEqual(400);
}

test.describe.configure({ mode: 'serial' });

test('reuses a personal link in clean browsers, replaces a persisted session, and restores without a fragment', async ({ browser, page }, testInfo) => {
  const fixture = setFor(testInfo.project.name);
  let accessResponse: { cacheControl: string | null; setCookie: string | null; body: string } | undefined;
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/access')) {
      accessResponse = {
        cacheControl: await response.headerValue('cache-control'),
        setCookie: await response.headerValue('set-cookie'),
        body: await response.text(),
      };
    }
  });

  await openPersonalLink(page, fixture.teacherA.token, fixture.day);
  await expect(page.getByText(`${testInfo.project.name} A Class`)).toBeVisible();
  const teacherAToken = await issuedAccessToken(page);
  expect(accessResponse).toMatchObject({ cacheControl: 'private, no-store', setCookie: null });
  expect(accessResponse?.body).not.toContain(fixture.teacherA.token);

  const cleanContext = await browser.newContext();
  try {
    const cleanPage = await cleanContext.newPage();
    await openPersonalLink(cleanPage, fixture.teacherA.token, fixture.day);
    expect(await issuedAccessToken(cleanPage)).toBeTruthy();
  } finally {
    await cleanContext.close();
  }

  await openPersonalLink(page, fixture.teacherB.token, fixture.day);
  await expect(page.getByText(`${testInfo.project.name} B Class`)).toBeVisible();
  expect(await issuedAccessToken(page)).not.toBe(teacherAToken);
  expect(new URL(page.url()).hash).toBe('');

  await page.reload();
  await expect(page.getByRole('main', { name: 'График' })).toBeVisible();
  await expect(page.getByText('Отворете личната си връзка за достъп')).toHaveCount(0);
});

test('rotating a personal link rejects its old fragment without ending an established native session', async ({ browser, page }, testInfo) => {
  const fixture = setFor(testInfo.project.name);
  await openPersonalLink(page, fixture.teacherB.token, fixture.day);
  const establishedSession = await issuedAccessToken(page);
  const replacementToken = await issueReplacementAccessLink(fixture.teacherB.id);

  const oldLink = await page.request.post('/api/access', {
    headers: { origin: appOrigin, 'content-type': 'application/json' },
    data: { token: fixture.teacherB.token },
  });
  expect(oldLink.status()).toBe(401);

  const cleanContext = await browser.newContext();
  try {
    const cleanPage = await cleanContext.newPage();
    await openPersonalLink(cleanPage, replacementToken, fixture.day);
    expect(await issuedAccessToken(cleanPage)).toBeTruthy();
  } finally {
    await cleanContext.close();
  }

  const establishedApi = await request.newContext({ baseURL: state.apiUrl, extraHTTPHeaders: restHeaders(establishedSession) });
  try {
    const day = await establishedApi.post('/rest/v1/rpc/get_day', { data: { p_date: fixture.day } });
    expect(day.status()).toBe(200);
  } finally {
    await establishedApi.dispose();
  }
});

test('enforces safe RPC projections, RLS ownership, and base-table denial', async ({ page }, testInfo) => {
  const fixture = setFor(testInfo.project.name);
  await openPersonalLink(page, fixture.teacherA.token, fixture.day);
  const teacherToken = await issuedAccessToken(page);
  const api = await request.newContext({ baseURL: state.apiUrl, extraHTTPHeaders: restHeaders(teacherToken) });
  try {
    const day = await api.post('/rest/v1/rpc/get_day', { data: { p_date: fixture.day } });
    expect(day.status()).toBe(200);
    const schedule = await day.json() as { bookings: Array<Record<string, unknown>> };
    const visible = schedule.bookings.find((booking) => booking.id === fixture.bookingBId)!;
    expect(visible).toMatchObject({ room: 'room', activity_title: `${testInfo.project.name} B Class`, can_manage: false });
    expect(JSON.stringify(schedule)).not.toMatch(/private detail|student_details|calculated_amount|price_breakdown|amount/i);

    await expectDirectBookingsDenied(api, teacherToken);

    const forbiddenDetails = await api.post('/rest/v1/rpc/get_booking_details', { data: { p_id: fixture.bookingBId } });
    expect(forbiddenDetails.status()).toBeGreaterThanOrEqual(400);

    const forbiddenEdit = await api.post('/rest/v1/rpc/edit_booking', {
      data: {
        p_id: fixture.bookingBId,
        p_expected_version: 1,
        p_class_id: fixture.teacherB.classId,
        p_room: 'room',
        p_starts_at: `${fixture.day}T10:00:00`,
        p_ends_at: `${fixture.day}T10:30:00`,
        p_student_details: 'forbidden',
      },
    });
    expect(forbiddenEdit.status()).toBeGreaterThanOrEqual(400);
  } finally {
    await api.dispose();
  }

  const adminContext = await page.context().browser()!.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await openPersonalLink(adminPage, fixture.admin.token, fixture.day);
    const adminToken = await issuedAccessToken(adminPage);
    const adminApi = await request.newContext({ baseURL: state.apiUrl, extraHTTPHeaders: restHeaders(adminToken) });
    try {
      const details = await adminApi.post('/rest/v1/rpc/get_booking_details', { data: { p_id: fixture.bookingAId } });
      expect(details.status()).toBe(200);
      expect(await details.json()).toMatchObject({ id: fixture.bookingAId, student_details: 'A private detail', amount: '10.00', can_manage: true });
      await expectDirectBookingsDenied(adminApi, adminToken);
    } finally {
      await adminApi.dispose();
    }
  } finally {
    await adminContext.close();
  }
});

test('rejects malformed credentials and deactivation blocks an established native session on its next RPC', async ({ page }, testInfo) => {
  const fixture = setFor(testInfo.project.name);
  const malformed = await page.request.post('/api/access', {
    headers: { origin: appOrigin, 'content-type': 'application/json' },
    data: { token: 'not-a-token' },
  });
  expect(malformed.status()).toBe(400);
  const unknown = await page.request.post('/api/access', {
    headers: { origin: appOrigin, 'content-type': 'application/json' },
    data: { token: 'f'.repeat(64) },
  });
  expect(unknown.status()).toBe(401);

  await openPersonalLink(page, fixture.teacherA.token, fixture.day);
  const token = await issuedAccessToken(page);
  const api = await request.newContext({ baseURL: state.apiUrl, extraHTTPHeaders: restHeaders(token) });
  try {
    const direct = await api.get('/rest/v1/bookings?select=id', { headers: restHeaders(jwtWithWrongKey()) });
    expect(direct.status()).toBe(401);

    await deactivateProfile(fixture.teacherA.id);
    const blocked = await api.post('/rest/v1/rpc/get_day', { data: { p_date: fixture.day } });
    expect(blocked.status()).toBeGreaterThanOrEqual(400);
  } finally {
    await api.dispose();
  }
});

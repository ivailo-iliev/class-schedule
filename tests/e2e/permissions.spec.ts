import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { request } from '@playwright/test';
import { expect, test } from '@playwright/test';
import type { E2EState } from './global-setup';

const statePath = resolve(dirname(new URL(import.meta.url).pathname), '../../test-results/e2e-state.json');
const state = JSON.parse(readFileSync(statePath, 'utf8')) as E2EState;
const appOrigin = 'http://localhost:4173';

function setFor(project: string) {
  return state.sets[project] ?? state.sets.chromium!;
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

function sofiaSlot(date: string, hour: number): string {
  return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+03:00`).toISOString();
}

type BookingSnapshot = {
  id: string;
  class_id: string;
  room: string;
  starts_at: string;
  cancelled_at: string | null;
  version: number;
};

async function bookingSnapshot(
  api: import('@playwright/test').APIRequestContext,
  accessToken: string,
  bookingId: string,
): Promise<BookingSnapshot> {
  const response = await api.get(`/rest/v1/bookings?id=eq.${bookingId}&select=id,class_id,room,starts_at,cancelled_at,version`, {
    headers: restHeaders(accessToken),
  });
  expect(response.status()).toBe(200);
  const rows = await response.json() as BookingSnapshot[];
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function expectDeniedMutation(response: import('@playwright/test').APIResponse): Promise<void> {
  if (response.status() === 200) {
    expect(await response.json()).toEqual([]);
    return;
  }
  expect(response.status()).toBeGreaterThanOrEqual(400);
}

async function verifyTeacherBookingPermissions(
  api: import('@playwright/test').APIRequestContext,
  accessToken: string,
  fixture: E2EState['sets'][string],
): Promise<void> {
  const bRows = await api.get(`/rest/v1/bookings?class_id=eq.${fixture.teacherB.classId}&select=id`, {
    headers: restHeaders(accessToken),
  });
  expect(bRows.status()).toBe(200);
  const bBookingId = (await bRows.json() as Array<{ id: string }>)[0]?.id;
  expect(bBookingId).toBeTruthy();
  const bBefore = await bookingSnapshot(api, accessToken, bBookingId!);

  const crossInsert = await api.post('/rest/v1/bookings', {
    headers: { ...restHeaders(accessToken), prefer: 'return=representation' },
    data: {
      class_id: fixture.teacherB.classId,
      room: 'room_1',
      starts_at: sofiaSlot(fixture.nextDay, 15),
    },
  });
  await expectDeniedMutation(crossInsert);

  const crossEdit = await api.patch(`/rest/v1/bookings?id=eq.${bBookingId}`, {
    headers: { ...restHeaders(accessToken), prefer: 'return=representation' },
    data: {
      room: 'room_2',
      starts_at: sofiaSlot(fixture.nextDay, 16),
    },
  });
  await expectDeniedMutation(crossEdit);

  const crossCancel = await api.patch(`/rest/v1/bookings?id=eq.${bBookingId}`, {
    headers: { ...restHeaders(accessToken), prefer: 'return=representation' },
    data: { cancelled_at: sofiaSlot(fixture.nextDay, 17) },
  });
  await expectDeniedMutation(crossCancel);

  const crossRpcEdit = await api.post('/rest/v1/rpc/edit_booking', {
    headers: restHeaders(accessToken),
    data: {
      p_id: bBookingId,
      p_expected_version: bBefore.version,
      p_class_id: fixture.teacherB.classId,
      p_room: 'room_2',
      p_date: fixture.nextDay,
      p_hour: 16,
    },
  });
  await expectDeniedMutation(crossRpcEdit);

  const crossRpcCancel = await api.post('/rest/v1/rpc/cancel_booking', {
    headers: restHeaders(accessToken),
    data: { p_id: bBookingId, p_expected_version: bBefore.version },
  });
  await expectDeniedMutation(crossRpcCancel);
  expect(await bookingSnapshot(api, accessToken, bBookingId!)).toEqual(bBefore);

  const ownInsert = await api.post('/rest/v1/bookings', {
    headers: { ...restHeaders(accessToken), prefer: 'return=representation' },
    data: {
      class_id: fixture.teacherA.classId,
      room: 'room_1',
      starts_at: sofiaSlot(fixture.nextDay, 13),
    },
  });
  expect(ownInsert.status()).toBe(201);
  const ownRows = await ownInsert.json() as Array<{ id: string }>;
  expect(ownRows).toHaveLength(1);
  const ownBookingId = ownRows[0]!.id;

  const ownEdit = await api.post('/rest/v1/rpc/edit_booking', {
    headers: restHeaders(accessToken),
    data: {
      p_id: ownBookingId,
      p_expected_version: 1,
      p_class_id: fixture.teacherA.classId,
      p_room: 'room_2',
      p_date: fixture.nextDay,
      p_hour: 14,
    },
  });
  expect(ownEdit.status()).toBe(200);

  const ownCancel = await api.post('/rest/v1/rpc/cancel_booking', {
    headers: restHeaders(accessToken),
    data: { p_id: ownBookingId, p_expected_version: 2 },
  });
  expect(ownCancel.status()).toBe(200);
  expect(await bookingSnapshot(api, accessToken, ownBookingId)).toMatchObject({
    class_id: fixture.teacherA.classId,
    room: 'room_2',
    cancelled_at: expect.any(String),
    version: 3,
  });
}

async function issuedAccessToken(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    for (const value of Object.values(localStorage)) {
      if (!value) continue;
      try {
        const parsed = JSON.parse(value) as { access_token?: unknown };
        if (typeof parsed.access_token === 'string') return parsed.access_token;
      } catch {
        // Other local-storage entries are not Supabase sessions.
      }
    }
    throw new Error('persisted native session was not found');
  });
}

async function openPersonalLink(page: import('@playwright/test').Page, token: string) {
  await page.goto(`/access#${token}`);
  await expect(page.getByRole('heading', { name: 'Daily schedule' })).toBeVisible();
  await expect(page.getByText('Room 1')).toBeVisible();
  await expect(page.getByText('Room 2')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('teacher A keeps a native session and sees both occupied rooms', async ({ page, context }, testInfo) => {
  const fixture = setFor(testInfo.project.name);
  let installCookie = '';
  page.on('response', async (response) => {
    if (response.url().endsWith('/api/access')) {
      installCookie = (await response.headerValue('set-cookie')) ?? '';
    }
  });
  await openPersonalLink(page, fixture.teacherA.token);
  await page.locator('input[type="date"]').fill(fixture.day);
  await expect(page.getByText(`${testInfo.project.name} B Class`)).toBeVisible();
  await expect(page.getByText(`${testInfo.project.name} A Class`)).toBeVisible();

  const accessToken = await issuedAccessToken(page);
  const api = await request.newContext({ baseURL: state.apiUrl });
  try {
    const schedule = await api.get('/rest/v1/bookings?select=id,room,classes(name,teacher_id)&order=starts_at', {
      headers: restHeaders(accessToken),
    });
    expect(schedule.status()).toBe(200);
    const rows = await schedule.json() as Array<{ room: string; classes: { name: string } }>;
    expect(rows.some((row) => row.room === 'room_1' && row.classes.name === `${testInfo.project.name} A Class`)).toBe(true);
    expect(rows.some((row) => row.room === 'room_2' && row.classes.name === `${testInfo.project.name} B Class`)).toBe(true);

    const wildcard = await api.get('/rest/v1/profiles?select=*', { headers: restHeaders(accessToken) });
    expect(wildcard.status()).not.toBe(200);

    const forbidden = await api.patch(`/rest/v1/classes?id=eq.${fixture.teacherB.classId}`, {
      headers: { ...restHeaders(accessToken), prefer: 'return=representation' },
      data: { name: 'forbidden teacher edit' },
    });
    expect(forbidden.status()).toBe(200);
    expect(await forbidden.json()).toEqual([]);

    const rpc = await api.post('/rest/v1/rpc/schedule_bookings', {
      headers: { ...restHeaders(accessToken), prefer: 'return=representation' },
      data: {
        p_class_id: fixture.teacherA.classId,
        p_room: 'room_1',
        p_first_date: fixture.nextDay,
        p_hour: 12,
        p_occurrences: 1,
      },
    });
    expect(rpc.status()).toBe(200);
    expect((await rpc.json() as unknown[])).toHaveLength(1);

    const conflict = await api.post('/rest/v1/rpc/schedule_bookings', {
      headers: restHeaders(accessToken),
      data: {
        p_class_id: fixture.teacherA.classId,
        p_room: 'room_1',
        p_first_date: fixture.nextDay,
        p_hour: 12,
        p_occurrences: 1,
      },
    });
    expect(conflict.status()).toBe(409);
  } finally {
    await api.dispose();
  }

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Daily schedule' })).toBeVisible();
  await expect(page.getByText('Open your personal access link')).toHaveCount(0);

  const cookies = await context.cookies(appOrigin);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') || installCookie.split(';', 1)[0];
  const manifestApi = await request.newContext({ baseURL: appOrigin });
  try {
    const manifest = await manifestApi.get(`/manifest.webmanifest?profile=${fixture.teacherA.id}`, {
      headers: { cookie: cookieHeader },
    });
    expect(manifest.status()).toBe(200);
    const body = await manifest.json() as { start_url: string; id: string; short_name: string };
    expect(body).toMatchObject({ id: '/', start_url: '/', short_name: `E2E ${testInfo.project.name} Teacher A` });
    expect(JSON.stringify(body)).not.toContain(fixture.teacherA.token);

    const mismatch = await manifestApi.get(`/manifest.webmanifest?profile=${fixture.teacherB.id}`, {
      headers: { cookie: cookieHeader },
    });
    expect(mismatch.status()).toBe(403);
  } finally {
    await manifestApi.dispose();
  }

  const writeApi = await request.newContext({ baseURL: state.apiUrl });
  try {
    await verifyTeacherBookingPermissions(writeApi, accessToken, fixture);
  } finally {
    await writeApi.dispose();
  }
});

test('teacher B can read A but cannot change A', async ({ page }, testInfo) => {
  const fixture = setFor(testInfo.project.name);
  await openPersonalLink(page, fixture.teacherB.token);
  await page.locator('input[type="date"]').fill(fixture.day);
  await expect(page.getByText(`${testInfo.project.name} A Class`)).toBeVisible();

  const accessToken = await issuedAccessToken(page);
  const api = await request.newContext({ baseURL: state.apiUrl });
  try {
    const forbidden = await api.patch(`/rest/v1/classes?id=eq.${fixture.teacherA.classId}`, {
      headers: { ...restHeaders(accessToken), prefer: 'return=representation' },
      data: { name: 'cross-teacher edit' },
    });
    expect(forbidden.status()).toBe(200);
    expect(await forbidden.json()).toEqual([]);
  } finally {
    await api.dispose();
  }
});

test('admin can edit another teacher through the real RLS boundary', async ({ page }, testInfo) => {
  const fixture = setFor(testInfo.project.name);
  await openPersonalLink(page, fixture.admin.token);
  const accessToken = await issuedAccessToken(page);
  const api = await request.newContext({ baseURL: state.apiUrl });
  const replacement = `${testInfo.project.name} B Class (admin check)`;
  try {
    const update = await api.patch(`/rest/v1/classes?id=eq.${fixture.teacherB.classId}`, {
      headers: { ...restHeaders(accessToken), prefer: 'return=representation' },
      data: { name: replacement },
    });
    expect(update.status()).toBe(200);
    expect((await update.json() as Array<{ name: string }>)[0]?.name).toBe(replacement);

    const restore = await api.patch(`/rest/v1/classes?id=eq.${fixture.teacherB.classId}`, {
      headers: { ...restHeaders(accessToken), prefer: 'return=minimal' },
      data: { name: `${testInfo.project.name} B Class` },
    });
    expect(restore.status()).toBe(204);
  } finally {
    await api.dispose();
  }
});

test('the access function and Supabase gateway reject invalid credentials', async ({ request: api }) => {
  const malformed = await api.post('/api/access', {
    headers: { origin: appOrigin, 'content-type': 'application/json' },
    data: { token: 'not-a-token' },
  });
  expect(malformed.status()).toBe(400);

  const unknown = await api.post('/api/access', {
    headers: { origin: appOrigin, 'content-type': 'application/json' },
    data: { token: 'f'.repeat(64) },
  });
  expect(unknown.status()).toBe(401);

  const direct = await request.newContext({ baseURL: state.apiUrl });
  try {
    for (const token of [
      'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJub25lIn0.',
      jwtWithWrongKey(),
    ]) {
      const denied = await direct.get('/rest/v1/bookings?select=id', {
        headers: restHeaders(token),
      });
      expect(denied.status()).toBe(401);
    }
  } finally {
    await direct.dispose();
  }
});

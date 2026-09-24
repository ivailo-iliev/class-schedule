import { beforeEach, describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import App from '../../src/App';
import { daySlots } from '../../src/lib/calendar';

const mocks = vi.hoisted(() => ({ getDay: vi.fn(), bootstrap: vi.fn(), auth: vi.fn(), profile: vi.fn() }));
vi.mock('../../src/lib/api', () => ({ getDay: mocks.getDay, getMyClasses: vi.fn(), getTeachers: vi.fn(), createClass: vi.fn(), updateClass: vi.fn(), scheduleBookings: vi.fn(), editBooking: vi.fn(), cancelBooking: vi.fn() }));
vi.mock('../../src/lib/session', () => ({ bootstrapNativeSession: mocks.bootstrap, onNativeAuthStateChange: mocks.auth, getProfile: mocks.profile }));

describe('App schedule integration', () => {
  beforeEach(() => {
    mocks.getDay.mockResolvedValue({ date: '2026-11-02', slots: daySlots('2026-11-02'), bookings: [] });
    mocks.bootstrap.mockResolvedValue({}); mocks.auth.mockReturnValue({ unsubscribe: vi.fn() });
    mocks.profile.mockReturnValue({ id: 'teacher', name: 'Teacher', role: 'teacher' });
  });
  test('loads the authoritative schedule after session bootstrap', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Зала' })).toBeInTheDocument();
    expect(mocks.getDay).toHaveBeenCalledTimes(1);
  });
});

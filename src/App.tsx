import { useCallback, useEffect, useRef, useState } from 'react';
import { bootstrapNativeSession, getProfile, onNativeAuthStateChange } from './lib/session';
import { ensurePrivateManifest, removePrivateManifest, useOnlineStatus } from './lib/pwa';
import type { Booking, DaySchedule } from './lib/types';
import BookingDetails from './components/BookingDetails';
import Schedule, { type ScheduleHandle } from './components/Schedule';

export default function App() {
  const [state, setState] = useState<'loading' | 'connected' | 'unavailable'>(() =>
    typeof window !== 'undefined' && window.location.hash.length > 1 ? 'loading' : 'unavailable',
  );
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const scheduleRef = useRef<ScheduleHandle>(null);
  const offline = !useOnlineStatus();

  useEffect(() => {
    let mounted = true;
    const subscription = onNativeAuthStateChange((session) => {
      if (!mounted) return;
      if (session) {
        const profileId = getProfile()?.id;
        if (profileId) ensurePrivateManifest(profileId);
        setState('connected');
      } else {
        removePrivateManifest();
        setState('unavailable');
      }
    });
    bootstrapNativeSession().then((session) => {
      if (!mounted || !session) return;
      const profileId = getProfile()?.id;
      if (profileId) ensurePrivateManifest(profileId);
      setState('connected');
    }).catch(() => {
      if (mounted) setState('unavailable');
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const refreshSchedule = useCallback((): Promise<DaySchedule | undefined> => {
    return scheduleRef.current?.refresh() ?? Promise.resolve(undefined);
  }, []);

  if (state === 'loading') {
    return <main><h1>Class Scheduler</h1><p>Connecting…</p></main>;
  }
  if (state === 'unavailable') {
    return <main><h1>Class Scheduler</h1><p>{offline
      ? 'You are offline. Reconnect before opening your personal access link.'
      : 'Open your personal access link'}</p></main>;
  }
  return (
    <>
      <Schedule
        ref={scheduleRef}
        onSelectBooking={setSelectedBooking}
        offline={offline}
      />
      {selectedBooking && (
        <BookingDetails
          booking={selectedBooking}
          onClose={() => setSelectedBooking(null)}
          onRefresh={refreshSchedule}
          offline={offline}
        />
      )}
    </>
  );
}

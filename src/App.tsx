import { useCallback, useEffect, useRef, useState } from 'react';
import { bootstrapNativeSession, onNativeAuthStateChange } from './lib/session';
import type { Booking, DaySchedule } from './lib/types';
import BookingDetails from './components/BookingDetails';
import Schedule, { type ScheduleHandle } from './components/Schedule';

export default function App() {
  const [state, setState] = useState<'loading' | 'connected' | 'unavailable'>(() =>
    typeof window !== 'undefined' && window.location.hash.length > 1 ? 'loading' : 'unavailable',
  );
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const scheduleRef = useRef<ScheduleHandle>(null);

  useEffect(() => {
    let mounted = true;
    const subscription = onNativeAuthStateChange((session) => {
      if (mounted && session) setState('connected');
      if (mounted && !session) setState('unavailable');
    });
    bootstrapNativeSession().then((session) => {
      if (mounted && session) setState('connected');
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
    return <main><h1>Class Scheduler</h1><p>Open your personal access link</p></main>;
  }
  return (
    <>
      <Schedule
        ref={scheduleRef}
        onSelectBooking={setSelectedBooking}
      />
      {selectedBooking && (
        <BookingDetails
          booking={selectedBooking}
          onClose={() => setSelectedBooking(null)}
          onRefresh={refreshSchedule}
        />
      )}
    </>
  );
}

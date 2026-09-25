import { useCallback, useEffect, useRef, useState } from 'react';
import { bootstrapNativeSession, getProfile, onNativeAuthStateChange } from './lib/session';
import { ensurePrivateManifest, removePrivateManifest, useOnlineStatus } from './lib/pwa';
import type { Booking, DaySchedule, Profile, Room } from './lib/types';
import BookingDetails from './components/BookingDetails';
import BookingForm from './components/BookingForm';
import Classes from './components/Classes';
import Schedule, { type ScheduleHandle } from './components/Schedule';

type SlotSelection = { date: string; hour: number; room: Room };

interface WorkspacePanelProps {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}

function WorkspacePanel({ label, onClose, children }: WorkspacePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="workspace-overlay" role="presentation">
      <div
        ref={panelRef}
        className="workspace-panel"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<'loading' | 'connected' | 'unavailable'>(() =>
    typeof window !== 'undefined' && window.location.hash.length > 1 ? 'loading' : 'unavailable',
  );
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<SlotSelection | null>(null);
  const [activeView, setActiveView] = useState<'schedule' | 'classes'>('schedule');
  const [profile, setProfile] = useState<Profile | null>(() => getProfile());
  const scheduleRef = useRef<ScheduleHandle>(null);
  const lastFocusedElement = useRef<HTMLElement | null>(null);
  const offline = !useOnlineStatus();

  useEffect(() => {
    let mounted = true;
    const subscription = onNativeAuthStateChange((session) => {
      if (!mounted) return;
      if (session) {
        const nextProfile = getProfile();
        setProfile(nextProfile);
        const profileId = nextProfile?.id;
        if (profileId) ensurePrivateManifest(profileId);
        setState('connected');
      } else {
        setProfile(null);
        removePrivateManifest();
        setState('unavailable');
      }
    });
    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const restore = () => {
      if (window.location.hash.length > 1) setState('loading');
      bootstrapNativeSession().then((session) => {
        if (!mounted) return;
        if (!session) {
          setProfile(null);
          setState('unavailable');
          return;
        }
        const nextProfile = getProfile();
        setProfile(nextProfile);
        const profileId = nextProfile?.id;
        if (profileId) ensurePrivateManifest(profileId);
        setState('connected');
      }).catch(() => {
        if (mounted) setState('unavailable');
      });
    };
    restore();
    window.addEventListener('hashchange', restore);
    return () => {
      mounted = false;
      window.removeEventListener('hashchange', restore);
    };
  }, []);

  const refreshSchedule = useCallback((): Promise<DaySchedule | undefined> => {
    return scheduleRef.current?.refresh() ?? Promise.resolve(undefined);
  }, []);

  const rememberTrigger = () => {
    lastFocusedElement.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  };

  const restoreTriggerFocus = () => {
    lastFocusedElement.current?.focus();
    lastFocusedElement.current = null;
  };

  const closeSlotPanel = () => {
    setSelectedSlot(null);
    restoreTriggerFocus();
  };

  const closeBookingPanel = () => {
    setSelectedBooking(null);
    restoreTriggerFocus();
  };

  if (state === 'loading') {
    return <main className="access-screen"><section className="access-card"><p className="eyebrow">Class Scheduler</p><h1>Preparing your workspace</h1><p>Connecting…</p></section></main>;
  }
  if (state === 'unavailable') {
    return (
      <main className="access-screen">
        <section className="access-card">
          <p className="eyebrow">Class Scheduler</p>
          <h1>Your teacher workspace</h1>
          <p>{offline
            ? 'You are offline. Reconnect before opening your personal access link.'
            : 'Open your personal access link'}</p>
        </section>
      </main>
    );
  }
  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-bar__inner">
          <div className="brand-lockup" aria-label="Class Scheduler">
            <span className="brand-mark" aria-hidden="true">C</span>
            <span>Class Scheduler</span>
          </div>
          <nav className="workspace-nav" aria-label="Teacher workspace">
            <button
              type="button"
              className={activeView === 'schedule' ? 'workspace-nav__item workspace-nav__item--active' : 'workspace-nav__item'}
              aria-current={activeView === 'schedule' ? 'page' : undefined}
              onClick={() => setActiveView('schedule')}
            >
              Schedule
            </button>
            <button
              type="button"
              className={activeView === 'classes' ? 'workspace-nav__item workspace-nav__item--active' : 'workspace-nav__item'}
              aria-current={activeView === 'classes' ? 'page' : undefined}
              onClick={() => setActiveView('classes')}
            >
              My classes
            </button>
          </nav>
          <div className="teacher-identity">
            <span className="teacher-identity__dot" aria-hidden="true" />
            <span>{profile?.name || 'Teacher'}</span>
          </div>
        </div>
      </header>

      {activeView === 'schedule' ? (
        <Schedule
          ref={scheduleRef}
          onSelectSlot={(slot) => {
            rememberTrigger();
            setSelectedSlot(slot);
          }}
          onSelectBooking={(booking) => {
            rememberTrigger();
            setSelectedBooking(booking);
          }}
          offline={offline}
        />
      ) : <Classes profile={profile} />}

      {selectedSlot && (
        <WorkspacePanel label="Book a room" onClose={closeSlotPanel}>
          <BookingForm
            date={selectedSlot.date}
            hour={selectedSlot.hour}
            room={selectedSlot.room}
            offline={offline}
            onRefresh={refreshSchedule}
            onDone={() => {
              closeSlotPanel();
              void refreshSchedule().catch(() => undefined);
            }}
          />
          <button className="workspace-panel__close" type="button" onClick={closeSlotPanel} aria-label="Close booking form">×</button>
        </WorkspacePanel>
      )}
      {selectedBooking && (
        <WorkspacePanel label="Booking details" onClose={closeBookingPanel}>
          <BookingDetails
            booking={selectedBooking}
            onClose={closeBookingPanel}
            onRefresh={refreshSchedule}
            offline={offline}
          />
        </WorkspacePanel>
      )}
    </div>
  );
}

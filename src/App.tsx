import { useCallback, useEffect, useRef, useState } from 'react';
import { bootstrapNativeSession, getProfile, onNativeAuthStateChange } from './lib/session';
import { useOnlineStatus } from './lib/network';
import type { Booking, DaySchedule, Profile, Room } from './lib/types';
import BookingDetails from './components/BookingDetails';
import BookingForm from './components/BookingForm';
import Classes from './components/Classes';
import Schedule, { type ScheduleHandle } from './components/Schedule';
import MonthlyReport from './components/MonthlyReport';

type SlotSelection = { date: string; startsAt: string; hour?: number; room: Room };

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
  const [activeView, setActiveView] = useState<'schedule' | 'classes' | 'report'>('schedule');
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
        if (!nextProfile) return;
        setProfile(nextProfile);
        setState('connected');
      } else {
        setProfile(null);
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
    return <main className="access-screen"><section className="access-card"><p className="eyebrow">График на класовете</p><h1>Подготвя се работното пространство</h1><p>Свързване…</p></section></main>;
  }
  if (state === 'unavailable') {
    return (
      <main className="access-screen">
        <section className="access-card">
          <p className="eyebrow">График на класовете</p>
          <h1>Работно пространство за учители</h1>
          <p>{offline
            ? 'Няма връзка с интернет. Свържете се отново, преди да отворите личната си връзка за достъп.'
            : 'Отворете личната си връзка за достъп'}</p>
        </section>
      </main>
    );
  }
  return (
    <div className="app-shell">
      <header className="app-bar">
        <div className="app-bar__inner">
          <nav className="workspace-nav" aria-label={profile?.role === 'admin' ? 'Работно пространство на администратора' : 'Работно пространство на учителя'}>
            <button
              type="button"
              className={activeView === 'schedule' ? 'workspace-nav__item workspace-nav__item--active' : 'workspace-nav__item'}
              aria-current={activeView === 'schedule' ? 'page' : undefined}
              onClick={() => setActiveView('schedule')}
            >
              График
            </button>
            <button
              type="button"
              className={activeView === 'classes' ? 'workspace-nav__item workspace-nav__item--active' : 'workspace-nav__item'}
              aria-current={activeView === 'classes' ? 'page' : undefined}
              onClick={() => setActiveView('classes')}
            >
              Моите класове
            </button>
            <button
              type="button"
              className={activeView === 'report' ? 'workspace-nav__item workspace-nav__item--active' : 'workspace-nav__item'}
              aria-current={activeView === 'report' ? 'page' : undefined}
              onClick={() => setActiveView('report')}
            >
              {profile?.role === 'admin' ? 'Администраторски отчет' : 'Месечен отчет'}
            </button>
          </nav>
          <div className="teacher-identity">
            <span className="teacher-identity__dot" aria-hidden="true" />
            <span>{profile?.name || 'Учител'}</span>
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
      ) : activeView === 'classes' ? <Classes profile={profile} /> : <MonthlyReport profile={profile!} />}

      {selectedSlot && (
        <WorkspacePanel label="Резервиране на зала" onClose={closeSlotPanel}>
          <BookingForm
            date={selectedSlot.date}
            startsAt={selectedSlot.startsAt}
            hour={selectedSlot.hour}
            room={selectedSlot.room}
            offline={offline}
            onRefresh={refreshSchedule}
            onCancel={closeSlotPanel}
            onDone={() => {
              // BookingForm already awaited this exact refresh before onDone.
            }}
          />
          <button className="workspace-panel__close" type="button" onClick={closeSlotPanel} aria-label="Затвори формуляра за резервация">×</button>
        </WorkspacePanel>
      )}
      {selectedBooking && (
        <WorkspacePanel label="Подробности за резервацията" onClose={closeBookingPanel}>
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

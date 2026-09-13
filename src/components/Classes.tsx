import { useEffect, useMemo, useState } from 'react';
import { createClass as createClassApi, getMyClasses, getTeachers, updateClass as updateClassApi } from '../lib/api';
import { getProfile } from '../lib/session';
import type { ClassItem, Profile } from '../lib/types';

type ClassLoader = () => Promise<ClassItem[]>;
type ClassCreator = (name: string, teacherId?: string) => Promise<ClassItem>;
type ClassUpdater = (
  id: string,
  changes: Partial<Pick<ClassItem, 'name' | 'active'>>,
) => Promise<ClassItem>;
type TeacherLoader = () => Promise<Profile[]>;

export interface ClassesProps {
  profile?: Profile | null;
  loadClasses?: ClassLoader;
  createClass?: ClassCreator;
  updateClass?: ClassUpdater;
  teachers?: Profile[];
  loadTeachers?: TeacherLoader;
}

function validateName(value: string): string | null {
  const name = value.trim();
  if (!name) return 'Enter a class name.';
  if (name.length > 100) return 'Class names must be 100 characters or fewer.';
  return null;
}

function sortClasses(items: ClassItem[]): ClassItem[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

function actionError(action: 'load' | 'save'): string {
  return action === 'load'
    ? 'Unable to load classes. Please try again.'
    : 'Unable to save that class. Please try again.';
}

export default function Classes({
  profile: suppliedProfile,
  loadClasses = getMyClasses,
  createClass = createClassApi,
  updateClass = updateClassApi,
  teachers: suppliedTeachers,
  loadTeachers = getTeachers,
}: ClassesProps) {
  const profile = suppliedProfile ?? getProfile();
  const isAdmin = profile?.role === 'admin';
  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [teachers, setTeachers] = useState<Profile[]>(suppliedTeachers ?? []);
  const [selectedTeacherId, setSelectedTeacherId] = useState('');
  const [className, setClassName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [archiveCandidate, setArchiveCandidate] = useState<ClassItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    void loadClasses().then((items) => {
      if (mounted) setClasses(sortClasses(items));
    }).catch(() => {
      if (mounted) setError(actionError('load'));
    }).finally(() => {
      if (mounted) setLoading(false);
    });

    if (isAdmin && suppliedTeachers === undefined) {
      void loadTeachers().then((items) => {
        if (mounted) setTeachers(items.filter((item) => item.role === 'teacher'));
      }).catch(() => {
        if (mounted) setError(actionError('load'));
      });
    }
    return () => { mounted = false; };
  }, [isAdmin, loadClasses, loadTeachers, suppliedTeachers]);

  const teacherOptions = useMemo(
    () => (suppliedTeachers ?? teachers).filter((item) => item.role === 'teacher'),
    [suppliedTeachers, teachers],
  );
  useEffect(() => {
    if (!isAdmin) return;
    setSelectedTeacherId((current) => teacherOptions.some((item) => item.id === current)
      ? current
      : (teacherOptions[0]?.id ?? ''));
  }, [isAdmin, teacherOptions]);

  const visibleClasses = isAdmin
    ? classes
    : classes.filter((item) => item.teacherId === profile?.id);

  const applyReturnedClass = (updated: ClassItem) => {
    setClasses((current) => sortClasses([
      ...current.filter((item) => item.id !== updated.id),
      updated,
    ]));
  };

  const handleCreate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validateName(className);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (isAdmin && !selectedTeacherId) {
      setError('Select a teacher who owns this class.');
      return;
    }
    setPendingAction('create');
    setError(null);
    setNotice(null);
    try {
      const created = await createClass(className.trim(), isAdmin ? selectedTeacherId : profile?.id);
      applyReturnedClass(created);
      setClassName('');
      setNotice(`Class “${created.name}” created.`);
    } catch {
      setError(actionError('save'));
    } finally {
      setPendingAction(null);
    }
  };

  const beginRename = (item: ClassItem) => {
    setEditingId(item.id);
    setEditingName(item.name);
    setError(null);
    setNotice(null);
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingName('');
  };

  const saveRename = async (event: React.FormEvent<HTMLFormElement>, item: ClassItem) => {
    event.preventDefault();
    const validationError = validateName(editingName);
    if (validationError) {
      setError(validationError);
      return;
    }
    setPendingAction(`rename:${item.id}`);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateClass(item.id, { name: editingName.trim() });
      applyReturnedClass(updated);
      cancelRename();
      setNotice(`Class “${updated.name}” renamed.`);
    } catch {
      setError(actionError('save'));
    } finally {
      setPendingAction(null);
    }
  };

  const changeActive = async (item: ClassItem, active: boolean) => {
    setPendingAction(`${active ? 'reactivate' : 'archive'}:${item.id}`);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateClass(item.id, { active });
      applyReturnedClass(updated);
      setArchiveCandidate(null);
      setNotice(active ? `Class “${updated.name}” reactivated.` : `Class “${updated.name}” archived.`);
    } catch {
      setError(actionError('save'));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <main className="classes-shell" aria-labelledby="classes-title">
      <header className="classes-header">
        <h1 id="classes-title">My classes</h1>
        <p>Maintain the class names used when booking rooms.</p>
      </header>

      {error && <p className="classes-message classes-message--error" role="alert">{error}</p>}
      {notice && <p className="classes-message classes-message--success" role="status">{notice}</p>}

      <section className="classes-panel" aria-labelledby="add-class-title">
        <h2 id="add-class-title">Add class</h2>
        <form onSubmit={handleCreate}>
          <label htmlFor="new-class-name">Class name</label>
          <input
            id="new-class-name"
            value={className}
            maxLength={100}
            onChange={(event) => setClassName(event.target.value)}
            aria-describedby="class-name-help"
          />
          <p id="class-name-help" className="classes-help">Use 1–100 characters.</p>
          {isAdmin && (
            <label htmlFor="class-owner">
              Class owner
              <select
                id="class-owner"
                value={selectedTeacherId}
                onChange={(event) => setSelectedTeacherId(event.target.value)}
              >
                <option value="">Select a teacher</option>
                {teacherOptions.map((teacherOption) => (
                  <option key={teacherOption.id} value={teacherOption.id}>
                    {teacherOption.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="submit" disabled={pendingAction === 'create'}>
            {pendingAction === 'create' ? 'Adding…' : 'Add class'}
          </button>
        </form>
      </section>

      <section className="classes-panel" aria-labelledby="class-list-title">
        <h2 id="class-list-title">Classes</h2>
        {loading && <p role="status">Loading classes…</p>}
        {!loading && visibleClasses.length === 0 && (
          <p role="status">You have no classes yet. Create a class before booking.</p>
        )}
        {!loading && visibleClasses.length > 0 && (
          <ul className="class-list" aria-label="Class list">
            {visibleClasses.map((item) => (
              <li className={`class-row${item.active ? '' : ' class-row--archived'}`} key={item.id}>
                {editingId === item.id ? (
                  <form className="class-rename-form" onSubmit={(event) => void saveRename(event, item)}>
                    <label htmlFor={`rename-${item.id}`} className="visually-hidden">Class name</label>
                    <input
                      id={`rename-${item.id}`}
                      aria-label={`Rename ${item.name}`}
                      value={editingName}
                      maxLength={100}
                      onChange={(event) => setEditingName(event.target.value)}
                    />
                    <button type="submit" disabled={pendingAction === `rename:${item.id}`}>Save</button>
                    <button type="button" onClick={cancelRename} disabled={pendingAction === `rename:${item.id}`}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="class-row__content">
                    <strong>{item.name}</strong>
                    {!item.active && <span className="class-status">Archived</span>}
                    {isAdmin && (
                      <span className="class-owner">
                        {teacherOptions.find((option) => option.id === item.teacherId)?.name ?? item.teacherId}
                      </span>
                    )}
                  </div>
                )}
                {editingId !== item.id && (
                  <div className="class-row__actions">
                    <button type="button" onClick={() => beginRename(item)} aria-label={`Rename ${item.name}`}>
                      Rename
                    </button>
                    {item.active ? (
                      <button
                        type="button"
                        onClick={() => setArchiveCandidate(item)}
                        disabled={pendingAction === `archive:${item.id}`}
                        aria-label={`Archive ${item.name}`}
                      >
                        Archive
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void changeActive(item, true)}
                        disabled={pendingAction === `reactivate:${item.id}`}
                        aria-label={`Reactivate ${item.name}`}
                      >
                        Reactivate
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {archiveCandidate && (
        <section className="classes-confirm" role="dialog" aria-modal="true" aria-labelledby="archive-title">
          <h2 id="archive-title">Archive {archiveCandidate.name}?</h2>
          <p>Already scheduled bookings for this class will remain. Archiving only prevents new bookings.</p>
          <div className="class-row__actions">
            <button
              type="button"
              onClick={() => void changeActive(archiveCandidate, false)}
              disabled={pendingAction === `archive:${archiveCandidate.id}`}
            >
              Archive class
            </button>
            <button type="button" onClick={() => setArchiveCandidate(null)}>
              Keep class
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

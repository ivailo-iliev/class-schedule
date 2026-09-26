import { useEffect, useMemo, useState } from 'react';
import { createClass as createClassApi, getMyClasses, getTeachers, updateClass as updateClassApi } from '../lib/api';
import { getProfile } from '../lib/session';
import type { ClassItem, Profile } from '../lib/types';
import Icon from './Icon';

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
  if (!name) return 'Въведете име на занимание.';
  if (name.length > 100) return 'Името на заниманието трябва да е до 100 знака.';
  return null;
}

function sortClasses(items: ClassItem[]): ClassItem[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

function actionError(action: 'load' | 'save'): string {
  return action === 'load'
    ? 'Заниманията не могат да бъдат заредени. Опитайте отново.'
    : 'Заниманието не може да бъде запазено. Опитайте отново.';
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
      setError('Изберете учител, към когото принадлежи това занимание.');
      return;
    }
    setPendingAction('create');
    setError(null);
    setNotice(null);
    try {
      const created = await createClass(className.trim(), isAdmin ? selectedTeacherId : undefined);
      applyReturnedClass(created);
      setClassName('');
      setNotice(`Заниманието „${created.name}“ е създадено.`);
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
      setNotice(`Името на заниманието „${updated.name}“ е променено.`);
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
      setNotice(active ? `Заниманието „${updated.name}“ е възстановено.` : `Заниманието „${updated.name}“ е архивирано.`);
    } catch {
      setError(actionError('save'));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <main className="classes-shell" aria-labelledby="class-list-title">

      {error && <p className="classes-message classes-message--error" role="alert">{error}</p>}
      {notice && <p className="classes-message classes-message--success" role="status">{notice}</p>}

      <section className="classes-panel" aria-labelledby="class-list-title">
        <h2 id="class-list-title">Занимания</h2>
        <h2 id="add-class-title" className="visually-hidden">Добавяне на занимание</h2>
        <form className="class-add" aria-labelledby="add-class-title" onSubmit={handleCreate}>
          <label htmlFor="new-class-name" className="visually-hidden">Име на заниманието</label>
          <input
            id="new-class-name"
            value={className}
            maxLength={100}
            placeholder="Ново занимание"
            onChange={(event) => setClassName(event.target.value)}
            aria-describedby="class-name-help"
          />
          <p id="class-name-help" className="visually-hidden">Използвайте от 1 до 100 знака.</p>
          {isAdmin && (
            <>
              <label htmlFor="class-owner" className="visually-hidden">Отговорен учител</label>
              <select
                id="class-owner"
                value={selectedTeacherId}
                onChange={(event) => setSelectedTeacherId(event.target.value)}
              >
                <option value="">Изберете учител</option>
                {teacherOptions.map((teacherOption) => (
                  <option key={teacherOption.id} value={teacherOption.id}>
                    {teacherOption.name}
                  </option>
                ))}
              </select>
            </>
          )}
          <button type="submit" className="icon-button icon-button--primary" disabled={pendingAction === 'create'} aria-busy={pendingAction === 'create'} aria-label="Добави занимание" title="Добави занимание">
            <Icon name="plus" />
          </button>
        </form>
        {loading && <p role="status">Заниманията се зареждат…</p>}
        {!loading && visibleClasses.length === 0 && (
          <p role="status">Все още нямате занимания. Създайте занимание, преди да направите резервация.</p>
        )}
        {!loading && visibleClasses.length > 0 && (
          <ul className="class-list" aria-label="Списък със занимания">
            {visibleClasses.map((item) => (
              <li className={`class-row${item.active ? '' : ' class-row--archived'}`} key={item.id}>
                {editingId === item.id ? (
                  <form className="class-rename-form" onSubmit={(event) => void saveRename(event, item)}>
                    <label htmlFor={`rename-${item.id}`} className="visually-hidden">Име на заниманието</label>
                    <input
                      id={`rename-${item.id}`}
                      aria-label={`Преименувай ${item.name}`}
                      value={editingName}
                      maxLength={100}
                      onChange={(event) => setEditingName(event.target.value)}
                    />
                    <button type="submit" className="icon-button icon-button--primary" disabled={pendingAction === `rename:${item.id}`} aria-label="Запази" title="Запази"><Icon name="check" /></button>
                    <button type="button" className="icon-button" onClick={cancelRename} disabled={pendingAction === `rename:${item.id}`} aria-label="Отказ" title="Отказ"><Icon name="x" /></button>
                  </form>
                ) : (
                  <div className="class-row__content">
                    <strong>{item.name}</strong>
                    {!item.active && <span className="class-status">Архивиран</span>}
                    {isAdmin && (
                      <span className="class-owner">
                        {teacherOptions.find((option) => option.id === item.teacherId)?.name ?? item.teacherId}
                      </span>
                    )}
                  </div>
                )}
                {editingId !== item.id && (
                  <div className="class-row__actions">
                    <button type="button" className="icon-button" onClick={() => beginRename(item)} aria-label={`Преименувай ${item.name}`} title="Преименувай"><Icon name="pencil" /></button>
                    {item.active ? (
                      <button
                        type="button"
                        className="icon-button icon-button--danger"
                        onClick={() => setArchiveCandidate(item)}
                        disabled={pendingAction === `archive:${item.id}`}
                        aria-label={`Архивирай ${item.name}`}
                        title="Архивирай"
                      >
                        <Icon name="archive" />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => void changeActive(item, true)}
                        disabled={pendingAction === `reactivate:${item.id}`}
                        aria-label={`Възстанови ${item.name}`}
                        title="Възстанови"
                      >
                        <Icon name="restore" />
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
          <h2 id="archive-title">Да архивираме ли „{archiveCandidate.name}“?</h2>
          <p>Вече планираните резервации за това занимание ще останат. Архивирането спира само създаването на нови резервации.</p>
          <div className="class-row__actions">
            <button
              type="button"
              onClick={() => void changeActive(archiveCandidate, false)}
              disabled={pendingAction === `archive:${archiveCandidate.id}`}
            >
              Архивирай заниманието
            </button>
            <button type="button" onClick={() => setArchiveCandidate(null)}>
              Остави заниманието
            </button>
          </div>
        </section>
      )}
    </main>
  );
}

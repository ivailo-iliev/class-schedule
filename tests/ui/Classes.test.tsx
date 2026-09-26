import { describe, expect, test, vi } from 'vitest';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Classes from '../../src/components/Classes';
import type { ClassItem, Profile } from '../../src/lib/types';

const teacher: Profile = { id: 'teacher-a', name: 'Teacher A', role: 'teacher' };
const teacherB: Profile = { id: 'teacher-b', name: 'Teacher B', role: 'teacher' };
const admin: Profile = { id: 'admin-1', name: 'Admin', role: 'admin' };

function classItem(overrides: Partial<ClassItem> = {}): ClassItem {
  return {
    id: 'class-1',
    teacherId: teacher.id,
    name: 'Pilates',
    active: true,
    ...overrides,
  };
}

function renderClasses(
  profile: Profile = teacher,
  classes: ClassItem[] = [classItem()],
  overrides: Partial<React.ComponentProps<typeof Classes>> = {},
) {
  return render(
    <Classes
      profile={profile}
      loadClasses={vi.fn(async () => classes)}
      createClass={vi.fn(async (name: string) => classItem({ id: 'class-new', name }))}
      updateClass={vi.fn(async (id: string, changes) => {
        const existing = classes.find((item) => item.id === id) ?? classItem({ id });
        return { ...existing, ...changes };
      })}
      {...overrides}
    />,
  );
}

describe('Classes screen', () => {
  test('uses the new activity terminology and omits the page title and description', async () => {
    renderClasses();

    expect(await screen.findByText('Pilates')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Занимания' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Моите класове' })).not.toBeInTheDocument();
    expect(screen.queryByText('Управлявайте имената на класовете, които използвате при резервация на зали.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Добави занимание' })).toBeInTheDocument();
  });
  test('shows only the teacher own classes as editable rows', async () => {
    renderClasses(teacher, [
      classItem(),
      classItem({ id: 'class-b', name: 'Teacher B class', teacherId: teacherB.id }),
    ]);

    expect(await screen.findByText('Pilates')).toBeInTheDocument();
    expect(screen.queryByText('Teacher B class')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Преименувай Pilates' })).toBeEnabled();
  });

  test('creates and renames a class with a trimmed valid name', async () => {
    const create = vi.fn(async (name: string) => classItem({ id: 'class-new', name }));
    const update = vi.fn(async (id: string, changes: Partial<Pick<ClassItem, 'name' | 'active'>>) =>
      classItem({ id, ...changes }));
    renderClasses(teacher, [], { createClass: create, updateClass: update });

    await screen.findByText(/Все още нямате занимания/i);
    fireEvent.change(screen.getByLabelText('Име на заниманието'), { target: { value: '  Dance  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добави занимание' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Dance', undefined));
    expect(await screen.findByText('Dance')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Преименувай Dance' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Преименувай Dance' }), { target: { value: '  Modern Dance ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Запази' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('class-new', { name: 'Modern Dance' }));
    expect(await screen.findByText('Modern Dance')).toBeInTheDocument();
  });

  test('validates whitespace-only and overlong names before saving', async () => {
    const create = vi.fn(async (name: string) => classItem({ name }));
    renderClasses(teacher, [], { createClass: create });
    await screen.findByText(/Все още нямате занимания/i);

    fireEvent.change(screen.getByLabelText('Име на заниманието'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добави занимание' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Въведете име на занимание.');
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Име на заниманието'), { target: { value: 'x'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: 'Добави занимание' }));
    expect(screen.getByRole('alert')).toHaveTextContent('до 100 знака');
    expect(create).not.toHaveBeenCalled();
  });

  test('archives only after warning that scheduled bookings remain and can reactivate', async () => {
    const update = vi.fn(async (id: string, changes: Partial<Pick<ClassItem, 'name' | 'active'>>) =>
      classItem({ id, ...changes }));
    renderClasses(teacher, [classItem()], { updateClass: update });
    await screen.findByText('Pilates');

    fireEvent.click(screen.getByRole('button', { name: 'Архивирай Pilates' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Вече планираните резервации за това занимание ще останат');
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Архивирай заниманието' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('class-1', { active: false }));
    expect(await screen.findByText('Архивиран')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Възстанови Pilates' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('class-1', { active: true }));
  });

  test('lets an admin select a teacher owner, while a teacher has no owner selector', async () => {
    const create = vi.fn(async (name: string, teacherId?: string) => classItem({ name, teacherId }));
    const renderedAdmin = renderClasses(admin, [classItem()], { teachers: [teacher, teacherB], createClass: create });

    expect(await screen.findByRole('combobox', { name: 'Отговорен учител' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Teacher A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Teacher B' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Отговорен учител' }), { target: { value: teacherB.id } });
    fireEvent.change(screen.getByLabelText('Име на заниманието'), { target: { value: 'Stretching' } });
    fireEvent.click(screen.getByRole('button', { name: 'Добави занимание' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Stretching', teacherB.id));

    renderedAdmin.unmount();
    renderClasses(teacher, [classItem()], { teachers: [teacher, teacherB] });
    expect(screen.queryByRole('combobox', { name: 'Отговорен учител' })).not.toBeInTheDocument();
  });
});

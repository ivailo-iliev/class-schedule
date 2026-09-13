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
  test('shows only the teacher own classes as editable rows', async () => {
    renderClasses(teacher, [
      classItem(),
      classItem({ id: 'class-b', name: 'Teacher B class', teacherId: teacherB.id }),
    ]);

    expect(await screen.findByText('Pilates')).toBeInTheDocument();
    expect(screen.queryByText('Teacher B class')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rename Pilates' })).toBeEnabled();
  });

  test('creates and renames a class with a trimmed valid name', async () => {
    const create = vi.fn(async (name: string) => classItem({ id: 'class-new', name }));
    const update = vi.fn(async (id: string, changes: Partial<Pick<ClassItem, 'name' | 'active'>>) =>
      classItem({ id, ...changes }));
    renderClasses(teacher, [], { createClass: create, updateClass: update });

    await screen.findByText(/no classes yet/i);
    fireEvent.change(screen.getByLabelText('Class name'), { target: { value: '  Dance  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Dance', teacher.id));
    expect(await screen.findByText('Dance')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rename Dance' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rename Dance' }), { target: { value: '  Modern Dance ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('class-new', { name: 'Modern Dance' }));
    expect(await screen.findByText('Modern Dance')).toBeInTheDocument();
  });

  test('validates whitespace-only and overlong names before saving', async () => {
    const create = vi.fn(async (name: string) => classItem({ name }));
    renderClasses(teacher, [], { createClass: create });
    await screen.findByText(/no classes yet/i);

    fireEvent.change(screen.getByLabelText('Class name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a class name.');
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Class name'), { target: { value: 'x'.repeat(101) } });
    fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
    expect(screen.getByRole('alert')).toHaveTextContent('100 characters or fewer');
    expect(create).not.toHaveBeenCalled();
  });

  test('archives only after warning that scheduled bookings remain and can reactivate', async () => {
    const update = vi.fn(async (id: string, changes: Partial<Pick<ClassItem, 'name' | 'active'>>) =>
      classItem({ id, ...changes }));
    renderClasses(teacher, [classItem()], { updateClass: update });
    await screen.findByText('Pilates');

    fireEvent.click(screen.getByRole('button', { name: 'Archive Pilates' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Already scheduled bookings for this class will remain');
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive class' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('class-1', { active: false }));
    expect(await screen.findByText('Archived')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reactivate Pilates' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('class-1', { active: true }));
  });

  test('lets an admin select a teacher owner, while a teacher has no owner selector', async () => {
    const create = vi.fn(async (name: string, teacherId?: string) => classItem({ name, teacherId }));
    const renderedAdmin = renderClasses(admin, [classItem()], { teachers: [teacher, teacherB], createClass: create });

    expect(await screen.findByRole('combobox', { name: 'Class owner' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Teacher A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Teacher B' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Class owner' }), { target: { value: teacherB.id } });
    fireEvent.change(screen.getByLabelText('Class name'), { target: { value: 'Stretching' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add class' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('Stretching', teacherB.id));

    renderedAdmin.unmount();
    renderClasses(teacher, [classItem()], { teachers: [teacher, teacherB] });
    expect(screen.queryByRole('combobox', { name: 'Class owner' })).not.toBeInTheDocument();
  });
});

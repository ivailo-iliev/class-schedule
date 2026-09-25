import { describe, expect, test } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import Schedule from '../../src/components/Schedule';

describe('Schedule screen', () => {
  test('does not offer unknown availability as free after an initial load failure', async () => {
    render(<Schedule initialDate="2026-11-02" loadSchedule={async () => { throw new Error('offline'); }} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/не е актуален/i);
    expect(screen.queryByRole('button', { name: /Book / })).not.toBeInTheDocument();
  });
});

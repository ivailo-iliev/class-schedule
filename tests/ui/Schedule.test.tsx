import { describe, test, expect } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import App from '../../src/App';

describe('Schedule screen', () => {
  test('shows personal access link prompt when no fragment exists', () => {
    render(<App />);
    expect(screen.getByText('Open your personal access link')).toBeInTheDocument();
  });
});

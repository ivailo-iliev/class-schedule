import '@testing-library/jest-dom';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  ensurePrivateManifest,
  manifestHref,
  removePrivateManifest,
} from '../../src/lib/pwa';

describe('PWA integration', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  test('builds a credential-free private manifest URL for a valid profile', () => {
    const profileId = '11111111-1111-4111-8111-111111111111';
    expect(manifestHref(profileId)).toBe('/manifest.webmanifest?profile=11111111-1111-4111-8111-111111111111');
    expect(manifestHref('not-a-profile')).toBeNull();
  });

  test('adds and replaces the per-profile manifest link after exchange', () => {
    const first = '11111111-1111-4111-8111-111111111111';
    const second = '22222222-2222-4222-8222-222222222222';

    ensurePrivateManifest(first);
    expect(document.head.querySelector('link[rel="manifest"]')).toHaveAttribute(
      'href',
      manifestHref(first)!,
    );

    ensurePrivateManifest(second);
    expect(document.head.querySelectorAll('link[rel="manifest"]')).toHaveLength(1);
    expect(document.head.querySelector('link[rel="manifest"]')).toHaveAttribute(
      'href',
      manifestHref(second)!,
    );
  });

  test('removes the private manifest link on sign-out', () => {
    ensurePrivateManifest('11111111-1111-4111-8111-111111111111');
    removePrivateManifest();
    expect(document.head.querySelector('link[rel="manifest"]')).not.toBeInTheDocument();
  });
});

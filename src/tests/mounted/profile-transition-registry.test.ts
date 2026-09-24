import { expect, it, vi } from 'vitest';
import {
  prepareProfileTransition,
  profileTransitionEditors,
  registerProfileTransitionEditor,
} from '../../app/data/profile-transition';

it('late completion of a canceled transition cannot resume a newer transition writer', async () => {
  let paused = false;
  const resume = vi.fn(() => {
    paused = false;
  });
  const unregister = registerProfileTransitionEditor({
    profileId: 'fictional-owner',
    pending: () => true,
    checkReady: () => {},
    save: async () => {},
    pause: () => {
      paused = true;
      return resume;
    },
  });
  try {
    const canceled = await prepareProfileTransition('fictional-owner', 'discard', () => true);
    canceled();
    expect(paused).toBe(false);
    const newer = await prepareProfileTransition('fictional-owner', 'discard', () => true);
    expect(paused).toBe(true);
    canceled();
    expect(paused).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    newer();
    expect(paused).toBe(false);
    expect(resume).toHaveBeenCalledTimes(2);
  } finally {
    unregister();
  }
  expect(profileTransitionEditors('fictional-owner')).toEqual([]);
});

it('checks all editors before saving and never pauses after a readiness failure', async () => {
  const saved = vi.fn(async () => {}),
    pause = vi.fn(() => () => {});
  const first = registerProfileTransitionEditor({
    profileId: 'fictional-owner',
    pending: () => true,
    checkReady: () => {},
    save: saved,
    pause,
  });
  const second = registerProfileTransitionEditor({
    profileId: 'fictional-owner',
    pending: () => true,
    checkReady: () => {
      throw new Error('Fictional attachment unresolved');
    },
    save: saved,
    pause,
  });
  try {
    await expect(prepareProfileTransition('fictional-owner', 'save', () => true)).rejects.toThrow(
      'attachment unresolved',
    );
    expect(saved).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  } finally {
    first();
    second();
  }
});

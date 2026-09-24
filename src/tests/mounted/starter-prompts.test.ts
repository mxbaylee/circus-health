import { describe, expect, it } from 'vitest';
import {
  sampleStarterPrompts,
  starterPromptCategories,
  starterPromptPool,
} from '../../app/features/assistant/starterPrompts';

describe('Moxie starter prompt pool', () => {
  it('keeps eight unique, readable questions in each intent category', () => {
    expect(starterPromptPool).toHaveLength(32);
    expect(new Set(starterPromptPool.map((prompt) => prompt.label)).size).toBe(32);

    for (const category of starterPromptCategories) {
      expect(starterPromptPool.filter((prompt) => prompt.category === category)).toHaveLength(8);
    }
    for (const prompt of starterPromptPool) {
      expect(prompt.label).toMatch(/\?$/);
      expect(prompt.label.trim().split(/\s+/).length).toBeGreaterThanOrEqual(7);
      expect(prompt.message).toBe(prompt.label);
    }
  });

  it('samples one unique prompt from every category', () => {
    const sampled = sampleStarterPrompts(() => 0.42);

    expect(sampled).toHaveLength(4);
    expect(new Set(sampled.map((prompt) => prompt.label)).size).toBe(4);
    expect(new Set(sampled.map((prompt) => prompt.category))).toEqual(
      new Set(starterPromptCategories),
    );
  });

  it('avoids the currently visible prompt from each category when refreshing', () => {
    const current = sampleStarterPrompts(() => 0);
    const refreshed = sampleStarterPrompts(() => 0, current);

    for (const prompt of refreshed) {
      expect(current.some((visible) => visible.label === prompt.label)).toBe(false);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { formatMessageTime } from '../../app/features/assistant/messageTime';

const now = new Date('2026-06-15T18:00:00Z');

describe('assistant message timestamps', () => {
  it('uses relative labels for recent messages and keeps an exact accessible value', () => {
    expect(
      formatMessageTime('2026-06-15T17:59:35Z', { locale: 'en-US', now, timeZone: 'UTC' }),
    ).toEqual({ short: 'Just now', full: 'Monday, June 15, 2026 at 5:59:35 PM UTC' });
    expect(
      formatMessageTime('2026-06-15T17:43:00Z', { locale: 'en-US', now, timeZone: 'UTC' }).short,
    ).toBe('17m ago');
    expect(
      formatMessageTime('2026-06-15T12:00:00Z', { locale: 'en-US', now, timeZone: 'UTC' }).short,
    ).toBe('6h ago');
  });

  it('formats older messages with the requested local clock and date', () => {
    const value = '2026-06-13T01:30:00Z';
    expect(
      formatMessageTime(value, { locale: 'en-US', now, timeZone: 'America/New_York' }),
    ).toEqual({
      short: 'Jun 12, 9:30 PM',
      full: 'Friday, June 12, 2026 at 9:30:00 PM EDT',
    });
    expect(formatMessageTime(value, { locale: 'en-US', now, timeZone: 'Asia/Tokyo' }).short).toBe(
      'Jun 13, 10:30 AM',
    );
  });

  it('includes the year outside the local current year and preserves invalid input', () => {
    expect(
      formatMessageTime('2025-12-31T23:30:00Z', {
        locale: 'en-US',
        now,
        timeZone: 'America/Los_Angeles',
      }).short,
    ).toBe('Dec 31, 2025, 3:30 PM');
    expect(formatMessageTime('unknown', { now })).toEqual({ short: 'unknown', full: 'unknown' });
  });
});

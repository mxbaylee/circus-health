type MessageTimeOptions = {
  locale?: string;
  now?: Date | number;
  timeZone?: string;
};

export type FormattedMessageTime = {
  full: string;
  short: string;
};

export function formatMessageTime(
  value: string,
  { locale, now = Date.now(), timeZone }: MessageTimeOptions = {},
): FormattedMessageTime {
  const date = new Date(value);
  const timestamp = date.getTime();
  const nowTimestamp = typeof now === 'number' ? now : now.getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(nowTimestamp))
    return { short: value, full: value };

  const full = new Intl.DateTimeFormat(locale, {
    dateStyle: 'full',
    timeStyle: 'long',
    timeZone,
  }).format(date);
  const elapsedSeconds = Math.floor((nowTimestamp - timestamp) / 1000);
  if (elapsedSeconds >= 0 && elapsedSeconds < 60) return { short: 'Just now', full };

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
  if (elapsedSeconds >= 0 && elapsedSeconds < 60 * 60)
    return { short: relative.format(-Math.floor(elapsedSeconds / 60), 'minute'), full };
  if (elapsedSeconds >= 0 && elapsedSeconds < 24 * 60 * 60)
    return { short: relative.format(-Math.floor(elapsedSeconds / 3600), 'hour'), full };

  const dateYear = new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone }).format(date);
  const nowYear = new Intl.DateTimeFormat(locale, { year: 'numeric', timeZone }).format(
    new Date(nowTimestamp),
  );
  return {
    short: new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
      ...(dateYear === nowYear ? {} : { year: 'numeric' as const }),
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(date),
    full,
  };
}

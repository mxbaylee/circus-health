export function formatDate(value: string | null | undefined): string {
  if (!value) return 'Date not recorded';
  if (/^\d{4}$/.test(value)) return value;
  if (/^\d{4}-\d{2}$/.test(value)) {
    const date = new Date(`${value}-01T12:00:00Z`);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('en-US', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(date)
      : value;
  }
  const timestamp = dateNumber(value);
  return timestamp !== null
    ? new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(timestamp))
    : value;
}

export function dateNumber(value: string | null | undefined): number | null {
  // Partial dates are not placed on an invented day for plotting.
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    return null;
  const time = Date.parse(value.length === 10 ? `${value}T12:00:00Z` : value);
  return Number.isFinite(time) ? time : null;
}

export const resultLink = (id: string) => `/tests?result=${encodeURIComponent(id)}&detail=1`;
export const testLink = (id: string) =>
  `/tests?view=by-test&type=${encodeURIComponent(id)}&detail=1`;
export const sourceLink = (id: string) => `/sources?record=${encodeURIComponent(id)}`;
export const formatBytes = (bytes: number) =>
  bytes >= 1048576
    ? `${(bytes / 1048576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${bytes} bytes`;

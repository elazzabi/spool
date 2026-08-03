import { basename } from 'node:path';

export interface IsoWeek {
  week: number;
  year: number;
}

function zonedCalendarDate(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

export function isoWeekAt(date: Date, timeZone: string): IsoWeek {
  const local = zonedCalendarDate(date, timeZone);
  const calendar = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const weekday = calendar.getUTCDay() || 7;
  calendar.setUTCDate(calendar.getUTCDate() + 4 - weekday);
  const year = calendar.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((calendar.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { week, year };
}

export function weeklyNoteFilename(date: Date, timeZone: string): string {
  const { week, year } = isoWeekAt(date, timeZone);
  return `Week ${week} of ${year}.md`;
}

export function parseWeeklyNoteFilename(path: string): IsoWeek | null {
  const match = /^Week ([1-9]|[1-4][0-9]|5[0-3]) of ([0-9]{4})\.md$/.exec(basename(path));
  return match?.[1] && match[2] ? { week: Number(match[1]), year: Number(match[2]) } : null;
}

export function isWeeklyNotePath(path: string): boolean {
  return parseWeeklyNoteFilename(path) !== null;
}

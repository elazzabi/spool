import { describe, expect, it } from 'vitest';

import {
  isWeeklyNotePath,
  isoWeekAt,
  parseWeeklyNoteFilename,
  weeklyNoteFilename,
} from '../../src/notes/week.js';

describe('weekly note identity', () => {
  it('uses ISO week-year in the configured timezone and accepts only exact filenames', () => {
    const instant = new Date('2027-01-03T22:30:00Z');

    expect(isoWeekAt(instant, 'Europe/Istanbul')).toEqual({ week: 1, year: 2027 });
    expect(weeklyNoteFilename(instant, 'Europe/Istanbul')).toBe('Week 1 of 2027.md');
    expect(parseWeeklyNoteFilename('/vault/Week 29 of 2026.md')).toEqual({
      week: 29,
      year: 2026,
    });
    expect(isWeeklyNotePath('/vault/week 29 of 2026.md')).toBe(false);
    expect(isWeeklyNotePath('/vault/Week 29 of 2026 (copy).md')).toBe(false);
  });
});

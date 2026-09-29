// Period vocabulary shared by the forecast sources and the engine: "2026-10" (a month) and
// "Q4-2026" / "2026-Q4" (a quarter), as inclusive calendar date ranges.

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface PeriodRange {
  start: DateParts;
  end: DateParts; // inclusive last day
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// "2026-10" → October 2026; "Q4-2026" (or "2026-Q4") → Oct–Dec 2026. Anything else → null.
export function parsePeriod(period: string): PeriodRange | null {
  const month = period.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (month) {
    const year = Number(month[1]);
    const m = Number(month[2]);
    return { start: { year, month: m, day: 1 }, end: { year, month: m, day: lastDayOfMonth(year, m) } };
  }
  const quarterFirst = period.match(/^Q([1-4])-(\d{4})$/i);
  const yearFirst = period.match(/^(\d{4})-Q([1-4])$/i);
  if (quarterFirst || yearFirst) {
    const q = Number(quarterFirst ? quarterFirst[1] : yearFirst![2]);
    const year = Number(quarterFirst ? quarterFirst[2] : yearFirst![1]);
    const first = (q - 1) * 3 + 1;
    return {
      start: { year, month: first, day: 1 },
      end: { year, month: first + 2, day: lastDayOfMonth(year, first + 2) },
    };
  }
  return null;
}

export function compareDates(a: DateParts, b: DateParts): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}


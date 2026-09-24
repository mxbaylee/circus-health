// Independently invented design fixtures; no values, dates or providers copied from profiles.
// Display examples only, not medical guidance or imported evidence.
export type TestId = 'ldl' | 'hdl' | 'total' | 'triglycerides' | 'tsh';
export type Result = { id: string; testId: TestId; date: string; value: number; provider: string };
export type Test = { id: TestId; name: string; category: string; unit: string };

export const tests: Test[] = [
  { id: 'ldl', name: 'LDL cholesterol', category: 'Cholesterol', unit: 'mg/dL' },
  { id: 'hdl', name: 'HDL cholesterol', category: 'Cholesterol', unit: 'mg/dL' },
  { id: 'total', name: 'Total cholesterol', category: 'Cholesterol', unit: 'mg/dL' },
  { id: 'triglycerides', name: 'Triglycerides', category: 'Lipids', unit: 'mg/dL' },
  { id: 'tsh', name: 'TSH', category: 'Thyroid', unit: 'mIU/L' },
];
const dates = ['2021-02-09', '2022-08-16', '2024-03-12', '2025-11-04'];
const values: Record<TestId, number[]> = {
  ldl: [102, 96, 108, 99],
  hdl: [48, 52, 46, 50],
  total: [171, 165, 176, 168],
  triglycerides: [105, 110, 115, 95],
  tsh: [2.4, 2.8, 2.2, 2.6],
};
export const results: Result[] = tests
  .flatMap((test) =>
    dates.map((date, i) => ({
      id: `${test.id}-${date}`,
      testId: test.id,
      date,
      value: values[test.id][i],
      provider: test.id === 'tsh' ? 'Starlight Lab (fictional)' : 'Moonbeam Clinic (fictional)',
    })),
  )
  .sort((a, b) => b.date.localeCompare(a.date));
export const providers = [...new Set(results.map((r) => r.provider))];
export const sampleToday = '2025-11-04';
export const weight = [
  { id: 'weight-1', date: '2021-02-09', value: 81.3 },
  { id: 'weight-2', date: '2022-08-16', value: 82.6 },
  { id: 'weight-3', date: '2024-03-12', value: 80.4 },
  { id: 'weight-4', date: '2025-11-04', value: 83.1 },
];
export const getTest = (id: TestId) => tests.find((t) => t.id === id)!;
export const seriesFor = (id: TestId, rows = results) =>
  rows.filter((r) => r.testId === id).sort((a, b) => a.date.localeCompare(b.date));
export const dateNumber = (date: string) => Date.parse(`${date}T12:00:00Z`);
export const formatDate = (date: string) =>
  new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(dateNumber(date)));
export const resultLink = (id: string) => `/tests?result=${encodeURIComponent(id)}&detail=1`;
export const testLink = (id: TestId) => `/tests?view=by-test&type=${id}&detail=1`;

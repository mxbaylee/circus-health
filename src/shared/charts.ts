/** A plotted value shared by record formatting and browser chart presentation. */
export interface ChartPoint {
  id: string;
  date: string;
  value: number;
  display?: string;
  provider?: string;
}

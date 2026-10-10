import { DatabaseSync } from 'node:sqlite';

/** Observe the real private cache so corruption controls keep targeting derived rows. */
export function captureReportRoutingScratch(t: { after(fn: () => void): void }) {
  const exec = DatabaseSync.prototype.exec;
  let selected: DatabaseSync | undefined;
  DatabaseSync.prototype.exec = function (sql: string) {
    if (sql.startsWith('CREATE TEMP TABLE __report_source_routing(')) selected = this;
    return Reflect.apply(exec, this, [sql]);
  };
  t.after(() => {
    DatabaseSync.prototype.exec = exec;
  });
  return () => {
    if (!selected) throw Error('Report routing scratch was not prepared');
    return selected;
  };
}

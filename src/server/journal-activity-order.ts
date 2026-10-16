import type { DatabaseSync } from 'node:sqlite';

interface Node {
  id: string;
  date: string;
  ordinal: number;
  left: string | null;
  right: string | null;
  height: number;
}
/** Disk AVL ordering preserves the journal owner's localeCompare and stable
 * directory order without collecting every batch header in memory. */
export class JournalActivityOrder {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(
      'CREATE TABLE activity_order(id TEXT PRIMARY KEY,date TEXT,ordinal INTEGER,left TEXT,right TEXT,height INTEGER); CREATE TABLE activity_order_root(id TEXT); INSERT INTO activity_order_root VALUES(NULL);',
    );
  }
  private node(id: string): Node {
    return this.db.prepare('SELECT * FROM activity_order WHERE id=?').get(id) as unknown as Node;
  }
  private height(id: string | null): number {
    return id === null ? 0 : this.node(id).height;
  }
  private save(node: Node): void {
    node.height = 1 + Math.max(this.height(node.left), this.height(node.right));
    this.db
      .prepare('INSERT OR REPLACE INTO activity_order VALUES(?,?,?,?,?,?)')
      .run(node.id, node.date, node.ordinal, node.left, node.right, node.height);
  }
  private compare(a: Node, b: Node): number {
    return b.date.localeCompare(a.date) || a.ordinal - b.ordinal;
  }
  private root(): string | null {
    return this.db.prepare('SELECT id FROM activity_order_root').get()!.id as string | null;
  }
  private rotate(id: string, right: boolean): string {
    const node = this.node(id),
      promoted = this.node((right ? node.left : node.right)!);
    if (right) {
      node.left = promoted.right;
      promoted.right = id;
    } else {
      node.right = promoted.left;
      promoted.left = id;
    }
    this.save(node);
    this.save(promoted);
    return promoted.id;
  }
  private balance(id: string): string {
    const node = this.node(id);
    this.save(node);
    const balance = this.height(node.left) - this.height(node.right);
    if (balance > 1) {
      const left = this.node(node.left!);
      if (this.height(left.left) < this.height(left.right)) {
        node.left = this.rotate(left.id, false);
        this.save(node);
      }
      return this.rotate(id, true);
    }
    if (balance < -1) {
      const right = this.node(node.right!);
      if (this.height(right.right) < this.height(right.left)) {
        node.right = this.rotate(right.id, true);
        this.save(node);
      }
      return this.rotate(id, false);
    }
    return id;
  }
  private insert(root: string | null, node: Node): string {
    if (root === null) {
      this.save(node);
      return node.id;
    }
    const parent = this.node(root);
    if (this.compare(node, parent) < 0) parent.left = this.insert(parent.left, node);
    else parent.right = this.insert(parent.right, node);
    this.save(parent);
    return this.balance(root);
  }
  private remove(root: string | null, wanted: Node): string | null {
    if (root === null) throw Error('Invalid journal activity ordering');
    const node = this.node(root),
      order = this.compare(wanted, node);
    if (order < 0) node.left = this.remove(node.left, wanted);
    else if (order > 0) node.right = this.remove(node.right, wanted);
    else {
      if (node.left === null || node.right === null) {
        this.db.prepare('DELETE FROM activity_order WHERE id=?').run(root);
        return node.left ?? node.right;
      }
      let successor = this.node(node.right);
      while (successor.left !== null) successor = this.node(successor.left);
      const right = this.remove(node.right, successor);
      this.db.prepare('DELETE FROM activity_order WHERE id=?').run(root);
      successor.left = node.left;
      successor.right = right;
      this.save(successor);
      return this.balance(successor.id);
    }
    this.save(node);
    return this.balance(root);
  }
  put(id: string, date: string, ordinal: number): void {
    const old = this.db.prepare('SELECT * FROM activity_order WHERE id=?').get(id) as unknown as
      Node | undefined;
    if (old?.date === date && old.ordinal === ordinal) return;
    let root = this.root();
    if (old) root = this.remove(root, old);
    root = this.insert(root, { id, date, ordinal, left: null, right: null, height: 1 });
    this.db.prepare('UPDATE activity_order_root SET id=?').run(root);
  }
  *ids(): Generator<string> {
    const stack: string[] = [];
    let id = this.root();
    while (id !== null || stack.length) {
      while (id !== null) {
        stack.push(id);
        id = this.node(id).left;
      }
      const node = this.node(stack.pop()!);
      yield node.id;
      id = node.right;
    }
  }
}

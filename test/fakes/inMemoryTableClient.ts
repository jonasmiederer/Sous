/**
 * In-memory TableClient for tests. Evaluates WriteConditions exactly like the
 * DynamoDB adapter, applies transactions all-or-nothing, and supports failure
 * injection so tests can prove failed writes leave prior state unchanged.
 */
import { ConditionFailedError, StorageError } from '../../src/data/errors.js';
import { GSI1_NAME, GSI2_NAME, GSI3_NAME, type TableKey } from '../../src/data/keys.js';
import {
  VERSION_ATTRIBUTE,
  type QueryInput,
  type QueryOutput,
  type TableClient,
  type TableItem,
  type TransactWriteOp,
  type WriteCondition,
} from '../../src/data/tableClient.js';

type Operation = 'get' | 'put' | 'delete' | 'query' | 'transactWrite';

const keyOf = (k: TableKey): string => JSON.stringify([k.PK, k.SK]);
const clone = <T>(v: T): T => structuredClone(v);

export class InMemoryTableClient implements TableClient {
  private readonly items = new Map<string, TableItem>();
  private readonly failures: Array<{ op: Operation; error: Error }> = [];
  /** Every call, for asserting on access patterns. */
  readonly calls: Array<{ op: Operation; input: unknown }> = [];

  /** Makes the next call of `op` throw `error` (default StorageError). */
  failNext(op: Operation, error: Error = new StorageError('injected failure')): void {
    this.failures.push({ op, error });
  }

  /** Snapshot of all stored items (deep copies). */
  dump(): TableItem[] {
    return [...this.items.values()].map(clone);
  }

  private record(op: Operation, input: unknown): void {
    this.calls.push({ op, input });
    const idx = this.failures.findIndex((f) => f.op === op);
    if (idx >= 0) {
      const [f] = this.failures.splice(idx, 1);
      throw f!.error;
    }
  }

  private check(key: TableKey, condition: WriteCondition | undefined): void {
    if (condition === undefined) return;
    const existing = this.items.get(keyOf(key));
    const ok =
      condition.kind === 'mustNotExist'
        ? existing === undefined
        : condition.kind === 'mustExist'
          ? existing !== undefined
          : existing !== undefined && existing[VERSION_ATTRIBUTE] === condition.version;
    if (!ok) throw new ConditionFailedError();
  }

  async get(key: TableKey): Promise<TableItem | undefined> {
    this.record('get', key);
    const item = this.items.get(keyOf(key));
    return item === undefined ? undefined : clone(item);
  }

  async put(item: TableItem, condition?: WriteCondition): Promise<void> {
    this.record('put', { item, condition });
    this.check(item, condition);
    this.items.set(keyOf(item), clone(item));
  }

  async delete(key: TableKey, condition?: WriteCondition): Promise<void> {
    this.record('delete', { key, condition });
    this.check(key, condition);
    this.items.delete(keyOf(key));
  }

  async query(input: QueryInput): Promise<QueryOutput> {
    this.record('query', input);
    const pkAttr =
      input.indexName === GSI1_NAME
        ? 'GSI1PK'
        : input.indexName === GSI2_NAME
          ? 'GSI2PK'
          : input.indexName === GSI3_NAME
            ? 'GSI3PK'
            : 'PK';
    const skAttr =
      input.indexName === GSI1_NAME
        ? 'GSI1SK'
        : input.indexName === GSI2_NAME
          ? undefined
          : input.indexName === GSI3_NAME
            ? 'GSI3SK'
            : 'SK';
    const skOf = (it: TableItem): string => (skAttr !== undefined && typeof it[skAttr] === 'string' ? (it[skAttr] as string) : it.SK);
    const matches = [...this.items.values()]
      .filter((it) => it[pkAttr] === input.partitionKey)
      .filter((it) => {
        if (input.sortKeyPrefix === undefined) return true;
        const sk = skAttr === undefined ? undefined : it[skAttr];
        return typeof sk === 'string' && sk.startsWith(input.sortKeyPrefix);
      })
      .filter((it) => {
        if (input.sortKeyBefore === undefined) return true;
        const sk = skAttr === undefined ? undefined : it[skAttr];
        return typeof sk === 'string' && sk < input.sortKeyBefore;
      })
      .sort((a, b) => (skOf(a) < skOf(b) ? -1 : skOf(a) > skOf(b) ? 1 : 0));
    const start = typeof input.exclusiveStartKey?.offset === 'number' ? input.exclusiveStartKey.offset : 0;
    const end = input.limit !== undefined ? start + input.limit : matches.length;
    const page = matches.slice(start, end).map(clone);
    return end < matches.length ? { items: page, lastEvaluatedKey: { offset: end } } : { items: page };
  }

  async transactWrite(ops: TransactWriteOp[]): Promise<void> {
    this.record('transactWrite', ops);
    for (const op of ops) this.check(op.kind === 'put' ? op.item : op.key, op.condition);
    for (const op of ops) {
      if (op.kind === 'put') this.items.set(keyOf(op.item), clone(op.item));
      else this.items.delete(keyOf(op.key));
    }
  }
}

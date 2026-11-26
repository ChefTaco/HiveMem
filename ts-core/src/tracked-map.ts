/**
 * A Map that remembers which keys changed since the last `takeDirty()`: every `set`, `delete`
 * and `clear` marks the keys it touches. The store keeps its persisted records in these, so a
 * checkpoint writes only what changed instead of the whole dataset. A record must therefore be
 * replaced with `set` (never edited in place) for the change to be saved; the test suite runs
 * with HIVEMEM_PERSISTENCE_VERIFY=1, which fails any change that bypassed `set`.
 */
export class TrackedMap<V> extends Map<string, V> {
  private dirty = new Set<string>();

  constructor() {
    super();
  }

  override set(key: string, value: V): this {
    this.dirty.add(key);
    return super.set(key, value);
  }

  override delete(key: string): boolean {
    this.dirty.add(key);
    return super.delete(key);
  }

  override clear(): void {
    for (const key of this.keys()) this.dirty.add(key);
    super.clear();
  }

  /** The keys changed since the last call; the set starts empty again. */
  takeDirty(): Set<string> {
    const dirty = this.dirty;
    this.dirty = new Set();
    return dirty;
  }
}

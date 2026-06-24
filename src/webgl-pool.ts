// Mirror of RenderConfig::default().webgl_pool_cap in src-tauri/src/config.rs.
// Kept below WebKit's hard ceiling of 16 live WebGL contexts (a margin absorbs
// disposed-but-not-yet-GC'd contexts, which keep counting under bug 218305).
const DEFAULT_CAP = 12;

interface PoolEntry {
  enable: () => void;
  disable: () => void;
  active: boolean;
}

export class WebglPool {
  private cap: number;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly lru: string[] = [];
  private enabled = true;
  private exhausted = false;

  constructor(cap = DEFAULT_CAP) {
    this.cap = cap;
  }

  setCap(cap: number): void {
    this.cap = Math.max(1, cap);
    while (this.activeCount() > this.cap && this.evictColdest()) {
      // keep evicting until the pool fits the new cap
    }
  }

  register(id: string, enable: () => void, disable: () => void): void {
    if (!this.entries.has(id))
      this.entries.set(id, { enable, disable, active: false });
  }

  unregister(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.active) entry.disable();
    this.entries.delete(id);
    this.drop(id);
  }

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on) {
      for (const entry of this.entries.values()) {
        if (entry.active) {
          entry.disable();
          entry.active = false;
        }
      }
      this.lru.length = 0;
    }
  }

  touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || !this.enabled || this.exhausted) return;
    this.drop(id);
    this.lru.unshift(id);
    if (entry.active) return;
    if (this.activeCount() >= this.cap) this.evict(id);
    entry.enable();
    // enable() may trip the fuse (a context-creation failure under WebKit's
    // limit); if it did, leave the entry on DOM rather than claim a slot.
    if (this.exhausted) return;
    entry.active = true;
  }

  // Once a context creation fails, WebKit has no slots left and any retry just
  // churns. Strand every pane on DOM and stop handing out contexts until the
  // webview reloads (the only thing that reclaims the leaked contexts).
  markExhausted(): void {
    if (this.exhausted) return;
    this.exhausted = true;
    for (const entry of this.entries.values()) {
      if (entry.active) {
        entry.disable();
        entry.active = false;
      }
    }
    this.lru.length = 0;
  }

  isExhausted(): boolean {
    return this.exhausted;
  }

  private activeCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.active) n += 1;
    return n;
  }

  private evict(keepId: string): void {
    for (let i = this.lru.length - 1; i >= 0; i -= 1) {
      const victimId = this.lru[i];
      if (victimId === keepId) continue;
      const victim = this.entries.get(victimId);
      if (victim?.active) {
        victim.disable();
        victim.active = false;
        this.lru.splice(i, 1);
        return;
      }
    }
  }

  private evictColdest(): boolean {
    for (let i = this.lru.length - 1; i >= 0; i -= 1) {
      const victim = this.entries.get(this.lru[i]);
      if (victim?.active) {
        victim.disable();
        victim.active = false;
        this.lru.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  private drop(id: string): void {
    const i = this.lru.indexOf(id);
    if (i !== -1) this.lru.splice(i, 1);
  }
}

export const webglPool = new WebglPool();

// ABOUTME: TD-28 gate around existing tab-session effects while a remount candidate is hidden.
// ABOUTME: Restore may read/acquire; saves and D21 projection wait until candidate promotion.
import type { SessionPayload, TabSessionReceipt } from "../editor/sessionPersistence";

export type SessionGateMode = "ordinary" | "candidate";

export interface SessionEffectGate {
  readonly mode: SessionGateMode;
  readonly hidden: boolean;
  acquire<T>(root: string, run: () => Promise<T>, end: () => Promise<void>): Promise<T>;
  save(
    session: SessionPayload,
    run: () => Promise<TabSessionReceipt>,
  ): Promise<TabSessionReceipt>;
  publishOpenTabs(run: () => Promise<void>): Promise<void>;
  promote(): Promise<void>;
  end(root: string, run: () => Promise<void>): Promise<void>;
  release(): Promise<void>;
}

class Gate implements SessionEffectGate {
  readonly mode: SessionGateMode;
  private committed: boolean;
  private bufferedProjection: (() => Promise<void>) | null = null;
  private sessions = new Map<string, {
    acquired: Promise<boolean>;
    end: () => Promise<void>;
    release: Promise<void> | null;
  }>();
  private releasedRoots = new Set<string>();
  private released = false;

  constructor(mode: SessionGateMode) {
    this.mode = mode;
    this.committed = mode === "ordinary";
  }

  get hidden(): boolean {
    return !this.committed;
  }

  private suppressedReceipt(session: SessionPayload): TabSessionReceipt {
    return {
      revision: "render-recovery-candidate",
      session,
      outcomes: session.tabs.map((tab) => ({ path: tab.path, status: "persisted_exact" as const })),
    };
  }

  async acquire<T>(root: string, run: () => Promise<T>, end: () => Promise<void>): Promise<T> {
    this.releasedRoots.delete(root);
    const acquisition = run();
    const acquired = acquisition.then(() => true, () => false);
    const session = { acquired, end, release: null };
    this.sessions.set(root, session);
    let result: T;
    try {
      result = await acquisition;
    } catch (error) {
      if (this.sessions.get(root) === session) this.sessions.delete(root);
      throw error;
    }
    if (this.released) await this.end(root, end);
    return result;
  }

  save(session: SessionPayload, run: () => Promise<TabSessionReceipt>): Promise<TabSessionReceipt> {
    if (this.committed && !this.released) return run();
    return Promise.resolve(this.suppressedReceipt(session));
  }

  publishOpenTabs(run: () => Promise<void>): Promise<void> {
    if (this.released) return Promise.resolve();
    if (this.committed) {
      return run();
    }
    this.bufferedProjection = run;
    return Promise.resolve();
  }

  async promote(): Promise<void> {
    if (this.released) throw new Error("render-recovery attempt is already released");
    if (this.committed) return;
    this.committed = true;
    const projection = this.bufferedProjection;
    this.bufferedProjection = null;
    if (projection) await projection();
  }

  end(root: string, run: () => Promise<void>): Promise<void> {
    const session = this.sessions.get(root);
    if (!session) return this.releasedRoots.has(root) ? Promise.resolve() : run();
    if (!session.release) {
      this.releasedRoots.add(root);
      session.release = session.acquired
        .then((didAcquire) => didAcquire ? run() : undefined)
        .finally(() => {
          if (this.sessions.get(root) === session) this.sessions.delete(root);
        });
    }
    return session.release;
  }

  async release(): Promise<void> {
    this.released = true;
    this.bufferedProjection = null;
    await Promise.all(
      [...this.sessions.entries()].map(([root, session]) => this.end(root, session.end)),
    );
  }
}

export function createSessionEffectGate(mode: SessionGateMode): SessionEffectGate {
  return new Gate(mode);
}

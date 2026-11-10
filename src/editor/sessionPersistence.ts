// ABOUTME: Owns one serialized, revisioned frontend write lane for each open project's tab session.
// ABOUTME: Carries backend receipts forward and releases writer authority only after queued saves drain.

export interface TabSnapshotPayload {
  path: string;
  /** Path-independent sidecar identity, present only for an untitled recovery document. */
  docId?: string;
  unsavedContent: string | null;
  recoveredFrom: string | null;
  /** Stable creation-order disambiguator for duplicate displaced-path labels. */
  displacedLabelOrdinal?: number;
  /** Explicit session-cap omission, which may coexist with later retained current text. */
  unsavedContentOmitted?: boolean;
  /** Durable presentation choice for the standing recovery-loss explanation. */
  lossNoticeCollapsed?: boolean;
}

export interface SessionPayload {
  tabs: TabSnapshotPayload[];
  activePath: string | null;
}

export type SessionSavePolicy = "background" | "require_untitled_lossless";
export type TabPersistenceStatus =
  | "restored_from_disk"
  | "persisted_exact"
  | "omitted_over_cap";

export interface TabPersistenceOutcome {
  path: string;
  status: TabPersistenceStatus;
}

export interface TabSessionSnapshot {
  canonicalRoot: string;
  attachmentId: string;
  revision: string;
  session: SessionPayload;
}

export interface TabSessionReceipt {
  revision: string;
  session: SessionPayload;
  outcomes: TabPersistenceOutcome[];
}

export interface TabSessionBackend {
  begin(root: string, writerId: string, attachmentId: string): Promise<TabSessionSnapshot>;
  save(
    root: string,
    writerId: string,
    attachmentId: string,
    expectedRevision: string,
    session: SessionPayload,
    policy: SessionSavePolicy,
  ): Promise<TabSessionReceipt>;
  prove(
    root: string,
    writerId: string,
    attachmentId: string,
    expectedRevision: string,
    session: SessionPayload,
  ): Promise<TabSessionReceipt>;
  end(root: string, writerId: string, attachmentId: string): Promise<void>;
}

interface ActiveLane {
  canonicalRoot: string;
  writerId: string;
  attachmentId: string;
  aliases: Set<string>;
  revision: string;
  tail: Promise<void>;
  closing: boolean;
  release: Promise<void> | null;
}

export interface SessionPersistence {
  begin(root: string): Promise<SessionPayload>;
  save(
    root: string,
    session: SessionPayload,
    policy?: SessionSavePolicy,
  ): Promise<TabSessionReceipt>;
  prove(root: string, session: SessionPayload): Promise<TabSessionReceipt>;
  end(root: string): Promise<void>;
}

interface WriterIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Keeps a browsing context's token stable across reload without sharing it with another window. */
export function createPersistentWriterId(
  storage: WriterIdStorage | undefined,
  createUuid: () => string = () => crypto.randomUUID(),
  windowScope = "browser",
): (root: string) => string {
  const key = `emend:tab-session-writer:${windowScope}`;
  let fallback: string | undefined;
  return (_root) => {
    try {
      const stored = storage?.getItem(key);
      if (stored) return stored;
    } catch {
      // A denied storage origin still gets stable ids for this renderer's module lifetime.
    }
    const writerId = fallback ?? `tab-session:${windowScope}:${createUuid()}`;
    fallback = writerId;
    try {
      storage?.setItem(key, writerId);
    } catch {
      // The in-memory fallback retains the lane identity until this renderer goes away.
    }
    return writerId;
  };
}

/** Builds the renderer's tab-session authority facade around the thin backend calls. */
export function createSessionPersistence(
  backend: TabSessionBackend,
  createWriterId: (root: string) => string = () => `tab-session:${crypto.randomUUID()}`,
  createAttachmentId: () => string = () => `tab-session-attachment:${crypto.randomUUID()}`,
): SessionPersistence {
  const attachmentId = createAttachmentId();
  const lanes = new Map<string, ActiveLane>();
  const aliases = new Map<string, ActiveLane>();

  return {
    async begin(root) {
      if (aliases.has(root)) {
        throw new Error(`tab-session lane already open for ${root}`);
      }
      const writerId = createWriterId(root);
      let snapshot = await backend.begin(root, writerId, attachmentId);
      let existing = lanes.get(snapshot.canonicalRoot);
      if (existing?.closing) {
        await existing.release;
        snapshot = await backend.begin(root, writerId, attachmentId);
        existing = lanes.get(snapshot.canonicalRoot);
      }
      if (existing) {
        existing.aliases.add(root);
        aliases.set(root, existing);
        return snapshot.session;
      }
      const lane: ActiveLane = {
        canonicalRoot: snapshot.canonicalRoot,
        writerId,
        attachmentId: snapshot.attachmentId,
        aliases: new Set([root]),
        revision: snapshot.revision,
        tail: Promise.resolve(),
        closing: false,
        release: null,
      };
      lanes.set(snapshot.canonicalRoot, lane);
      aliases.set(root, lane);
      return snapshot.session;
    },

    save(root, session, policy = "background") {
      const lane = aliases.get(root);
      if (!lane || lane.closing) {
        return Promise.reject(new Error(`tab-session lane is not open for ${root}`));
      }
      let resolveReceipt!: (receipt: TabSessionReceipt) => void;
      let rejectReceipt!: (reason: unknown) => void;
      const result = new Promise<TabSessionReceipt>((resolve, reject) => {
        resolveReceipt = resolve;
        rejectReceipt = reject;
      });
      lane.tail = lane.tail
        .catch(() => undefined)
        .then(async () => {
          try {
            const receipt = await backend.save(
              lane.canonicalRoot,
              lane.writerId,
              lane.attachmentId,
              lane.revision,
              session,
              policy,
            );
            lane.revision = receipt.revision;
            resolveReceipt(receipt);
          } catch (error) {
            rejectReceipt(error);
          }
        });
      return result;
    },

    prove(root, session) {
      const lane = aliases.get(root);
      if (!lane || lane.closing) {
        return Promise.reject(new Error(`tab-session lane is not open for ${root}`));
      }
      let resolveReceipt!: (receipt: TabSessionReceipt) => void;
      let rejectReceipt!: (reason: unknown) => void;
      const result = new Promise<TabSessionReceipt>((resolve, reject) => {
        resolveReceipt = resolve;
        rejectReceipt = reject;
      });
      lane.tail = lane.tail
        .catch(() => undefined)
        .then(async () => {
          try {
            const receipt = await backend.prove(
              lane.canonicalRoot,
              lane.writerId,
              lane.attachmentId,
              lane.revision,
              session,
            );
            resolveReceipt(receipt);
          } catch (error) {
            rejectReceipt(error);
          }
        });
      return result;
    },

    async end(root) {
      const lane = aliases.get(root);
      if (!lane) return;
      aliases.delete(root);
      lane.aliases.delete(root);
      if (lane.aliases.size > 0) return;
      lane.closing = true;
      lane.release = lane.tail
        .catch(() => undefined)
        .then(() => backend.end(lane.canonicalRoot, lane.writerId, lane.attachmentId))
        .finally(() => {
          if (lanes.get(lane.canonicalRoot) === lane) lanes.delete(lane.canonicalRoot);
        });
      await lane.release;
    },
  };
}

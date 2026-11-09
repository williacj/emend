// ABOUTME: Tests for the document-birth subscription + card mapping (#420) — the frontend end of
// ABOUTME: the J2 Phase B pipe: which backend event it listens to, and how one notice becomes a
// ABOUTME: document-birth card.
import { beforeEach, describe, expect, it, vi } from "vitest";

const listenForBackendEventMock = vi.fn();
vi.mock("./driverEvents", () => ({
  listenForBackendEvent: (...args: unknown[]) => listenForBackendEventMock(...args),
}));

const { DOCUMENT_BIRTH_EVENT, documentBirthCardFor, listenForDocumentBirths } = await import(
  "./documentBirth"
);

/** A notice shaped exactly like the Rust `agent::birth::DocumentBirthNotice` wire form. */
function notice(overrides: Partial<Record<string, unknown>> = {}) {
  return { path: "drafts/outline.md", size: 128, ...overrides };
}

describe("stores/documentBirth — subscribing to backend document births", () => {
  beforeEach(() => {
    listenForBackendEventMock.mockReset();
  });

  it("listens on the document-birth event and hands the notice payload to the handler", async () => {
    let emit: ((payload: unknown) => void) | undefined;
    const unlisten = vi.fn();
    listenForBackendEventMock.mockImplementation((_name: string, cb: (payload: unknown) => void) => {
      emit = cb;
      return Promise.resolve(unlisten);
    });

    const handler = vi.fn();
    const stop = await listenForDocumentBirths(handler);

    expect(listenForBackendEventMock).toHaveBeenCalledWith(DOCUMENT_BIRTH_EVENT, expect.any(Function));
    const n = notice();
    emit?.(n);
    expect(handler).toHaveBeenCalledWith(n);

    stop();
    expect(unlisten).toHaveBeenCalled();
  });

});

describe("stores/documentBirth — one notice becomes one document-birth card", () => {
  it("carries the notice's path and size onto the card", () => {
    const card = documentBirthCardFor(notice(), { id: "c-1", timestamp: "T" });

    expect(card.kind).toBe("document-birth");
    expect(card.path).toBe("drafts/outline.md");
    expect(card.size).toBe(128);
    expect(card.id).toBe("c-1");
    expect(card.timestamp).toBe("T");
  });

  it("generates a distinct id per call when none is given", () => {
    const first = documentBirthCardFor(notice());
    const second = documentBirthCardFor(notice({ path: "drafts/second.md" }));

    expect(first.id).not.toBe(second.id);
  });
});

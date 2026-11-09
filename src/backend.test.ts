// ABOUTME: Covers the shared `callBackend` transport (extracted from `editor/ipc.ts`, P2a-22) —
// ABOUTME: the Tauri-IPC / D23-test-driver dispatch every ipc module built on it inherits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const isTauriMock = vi.fn(() => true);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
  isTauri: () => isTauriMock(),
}));

const { callBackend, errorDetail, formatDocumentActionFailure, UserFacingError } =
  await import("./backend");

describe("callBackend — inside a Tauri webview", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockClear();
  });

  it("dispatches through invoke() with the command and args", async () => {
    invokeMock.mockResolvedValueOnce({ ok: true });

    const result = await callBackend("some_command", { a: 1 });

    expect(invokeMock).toHaveBeenCalledWith("some_command", { a: 1 });
    expect(result).toEqual({ ok: true });
  });
});

describe("callBackend — outside a Tauri webview (D23 headless test driver)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    isTauriMock.mockReturnValue(false);
    invokeMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_TEST_DRIVER_URL", "http://127.0.0.1:4711");
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("posts to the test driver's /<command> endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await callBackend("some_command", { a: 1 });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/some_command",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ a: 1 }) }),
    );
    expect(result).toEqual({ ok: true });
  });

  it("a non-2xx response rejects with the driver's error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: "Whatever", message: "nope" }), { status: 422 }),
    );

    await expect(callBackend("some_command", {})).rejects.toEqual({
      kind: "Whatever",
      message: "nope",
    });
  });

  it("falls back to the default driver URL when none is configured", async () => {
    vi.unstubAllEnvs();
    fetchMock.mockResolvedValueOnce(new Response("null", { status: 200 }));

    await callBackend("some_command", {});

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4711/some_command",
      expect.anything(),
    );
  });
});

// #2230: four independent "read the message off a rejected backend call" implementations existed
// in `src/`. `errorDetail` is now the only one; the divergence that mattered — what a surface says
// when the rejection carries no readable message at all — is an explicit argument, because that
// wording is `ux-design.md` §4's Status region to choose, per surface, not the reader's to invent.
describe("errorDetail — the one reader of a rejected call's human-readable half (FR-X-5)", () => {
  it("trims a thrown Error's message", () => {
    expect(errorDetail(new Error("  backend went away  "))).toBe("backend went away");
  });

  it("trims a bare string rejection", () => {
    expect(errorDetail("  backend went away  ")).toBe("backend went away");
  });

  it("reads the typed CommandError shape both transports produce", () => {
    // `#[serde(tag = "kind", content = "message")]` (`commands::agent::CommandError`) — a plain
    // object, never an `Error`, so an `instanceof Error` reader coerces it to `[object Object]`.
    expect(errorDetail({ kind: "InvalidArguments", message: "prompt was blank" })).toBe(
      "prompt was blank",
    );
  });

  it("defaults to the empty string when the rejection carries no readable message", () => {
    expect(errorDetail({})).toBe("");
    expect(errorDetail(undefined)).toBe("");
    expect(errorDetail(null)).toBe("");
    expect(errorDetail(42)).toBe("");
    // A `message` that isn't a string is not a message — coercing it would print `42` as if the
    // backend had said it.
    expect(errorDetail({ message: 42 })).toBe("");
  });

  it("returns the caller's fallback — not the empty string — for a rejection with no message", () => {
    expect(errorDetail({}, "The project could not be scanned.")).toBe(
      "The project could not be scanned.",
    );
    expect(errorDetail(undefined, String(undefined))).toBe("undefined");
    expect(errorDetail({}, String({}))).toBe("[object Object]");
  });

  it("never substitutes the fallback for an empty message the rejection really carried", () => {
    // An `Error("")` genuinely said nothing; that is not the same as a rejection shape this reader
    // does not recognise, and a surface that wants "Try again." for both says so itself (`||`).
    expect(errorDetail(new Error(""), "fallback")).toBe("");
    expect(errorDetail(new Error("   "), "fallback")).toBe("");
    expect(errorDetail({ kind: "X", message: "" }, "fallback")).toBe("");
  });
});

describe("formatDocumentActionFailure", () => {
  it("names the document action for an ordinary backend rejection", () => {
    expect(formatDocumentActionFailure({ kind: "Io", message: "The document could not be read" }))
      .toBe("Cowrite couldn’t complete the document action. The document could not be read");
  });

  it("falls back rather than trailing a dangling prefix", () => {
    expect(formatDocumentActionFailure({})).toBe(
      "Cowrite couldn’t complete the document action. Try again.",
    );
  });

  it("passes a reporter's complete sentence through without naming a subject of its own", () => {
    // A window that refused to close is not a document action, and the shell must not relabel it
    // as one (#2327).
    expect(formatDocumentActionFailure(
      new UserFacingError("The window didn’t close, so nothing was closed or discarded."),
    )).toBe("The window didn’t close, so nothing was closed or discarded.");
  });

  it("keeps the document wording for an ordinary Error, which claims nothing about its framing", () => {
    expect(formatDocumentActionFailure(new Error("permission denied"))).toBe(
      "Cowrite couldn’t complete the document action. permission denied",
    );
  });
});

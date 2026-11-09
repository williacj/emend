// @vitest-environment jsdom
// ABOUTME: Mounted CM6 dictation ghost preserves source and history across author projections.
// ABOUTME: Exercises the shared path-free editor surface that file-backed and untitled panes use.
import { undo, undoDepth } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createRef } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentSurface, type DocumentSurfaceHandle } from "./DocumentSurface";
import { setDisplayMode, setSourceView } from "./viewMode";
import { invalidateVoiceStatus, publishVoiceStatus, SharedDictationMic } from "../voice/SharedDictationMic";
import type { VoiceDictationEvent, VoiceStatus } from "../settings/voiceIpc";
import { cancelVoiceDictation, downloadVoiceModel, getVoiceStatus, startVoiceDictation } from "../settings/voiceIpc";
import { listenForBackendEvent } from "../stores/driverEvents";

vi.mock("../settings/voiceIpc", async (importActual) => {
  const actual = await importActual<typeof import("../settings/voiceIpc")>();
  return { ...actual, startVoiceDictation: vi.fn(), getVoiceStatus: vi.fn(), cancelVoiceDictation: vi.fn(), downloadVoiceModel: vi.fn() };
});

vi.mock("../stores/driverEvents", async (importActual) => {
  const actual = await importActual<typeof import("../stores/driverEvents")>();
  return { ...actual, listenForBackendEvent: vi.fn().mockResolvedValue(() => {}) };
});

vi.mock("./ipc", async (importActual) => {
  const actual = await importActual<typeof import("./ipc")>();
  return { ...actual, parseChanges: vi.fn().mockResolvedValue([]) };
});

describe("editor/DocumentSurface dictation ghost (#2619)", () => {
  it("#2650 holds the original selected range while the caret moves and retires it on Final", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abcdef", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 2, head: 4 } });
      expect(surface.current!.captureDictationTarget()).toBe(true);
      expect(surface.current!.beginDictation(2650)).toBe(true);
    });
    expect(mounted.container.querySelector(".cm-dictation-held-range")).toHaveTextContent("cd");
    act(() => {
      view.dispatch({ selection: { anchor: 0 } });
      expect(surface.current!.showDictationPartial(2650, "spoken")).toBe(true);
    });
    expect(mounted.container.querySelector(".cm-dictation-held-range")).toHaveTextContent("cd");
    expect(view.posAtDOM(mounted.container.querySelector(".cm-dictation-ghost")!)).toBe(4);
    act(() => expect(surface.current!.commitDictationFinal(2650, "VOICE")).toBe(true));
    expect(view.state.doc.toString()).toBe("abVOICEef");
    expect(mounted.container.querySelector(".cm-dictation-held-range")).toBeNull();
    mounted.unmount();
  });
  it("retires an accepted selected range when an author edit overlaps it", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abcdef", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 2, head: 4 } });
      expect(surface.current!.captureDictationTarget()).toBe(true);
      expect(surface.current!.beginDictation(48)).toBe(true);
      expect(surface.current!.showDictationPartial(48, "spoken")).toBe(true);
      view.dispatch({ changes: { from: 1, to: 5, insert: "Z" } });
    });
    expect(view.state.doc.toString()).toBe("aZf");
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    act(() => expect(surface.current!.commitDictationFinal(48, "late")).toBe(false));
    expect(view.state.doc.toString()).toBe("aZf");
    mounted.unmount();
  });
  it("retires an accepted selected range when the author replaces it exactly", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abcdef", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 2, head: 4 } });
      expect(surface.current!.captureDictationTarget()).toBe(true);
      expect(surface.current!.beginDictation(49)).toBe(true);
      expect(surface.current!.showDictationPartial(49, "spoken")).toBe(true);
      view.dispatch({ changes: { from: 2, to: 4, insert: "XYZ" } });
    });
    expect(view.state.doc.toString()).toBe("abXYZef");
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    act(() => expect(surface.current!.commitDictationFinal(49, "late")).toBe(false));
    expect(view.state.doc.toString()).toBe("abXYZef");
    mounted.unmount();
  });
  it("retires a selected range after an insertion inside it", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abcdef", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 2, head: 4 } });
      expect(surface.current!.captureDictationTarget()).toBe(true);
      expect(surface.current!.beginDictation(53)).toBe(true);
      view.dispatch({ changes: { from: 3, insert: "!" } });
      expect(surface.current!.commitDictationFinal(53, "late")).toBe(false);
    });
    expect(view.state.doc.toString()).toBe("abc!def");
    mounted.unmount();
  });
  it("refuses delayed Begin after an author edit replaces the captured range", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abcdef", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 2, head: 4 } });
      expect(surface.current!.captureDictationTarget()).toBe(true);
      view.dispatch({ changes: { from: 2, to: 4, insert: "XYZ" } });
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      expect(surface.current!.beginDictation(50)).toBe(false);
      expect(surface.current!.commitDictationFinal(50, "late")).toBe(false);
    });
    expect(view.state.doc.toString()).toBe("abXYZef");
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    mounted.unmount();
  });
  it("keeps a selected target through an edit after the range", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abcdef", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 2, head: 4 } });
      expect(surface.current!.captureDictationTarget()).toBe(true);
      view.dispatch({ changes: { from: 6, insert: "!" } });
      view.dispatch({ selection: { anchor: 0 } });
      expect(surface.current!.beginDictation(52)).toBe(true);
      expect(surface.current!.commitDictationFinal(52, "VOICE")).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("abVOICEef!");
    mounted.unmount();
  });
  it("cancels active editor dictation when its selected range is overwritten", async () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    vi.mocked(getVoiceStatus).mockReset().mockResolvedValue(ready);
    vi.mocked(startVoiceDictation).mockReset().mockResolvedValue({ ...ready, accepted_generation: 51 });
    vi.mocked(cancelVoiceDictation).mockReset().mockResolvedValue(ready);
    vi.mocked(listenForBackendEvent).mockClear();
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abcdef", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 2, head: 4 } });
      publishVoiceStatus(ready);
    });
    fireEvent.click(mounted.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(startVoiceDictation).toHaveBeenCalledOnce());
    const listener = vi.mocked(listenForBackendEvent).mock.calls.find(([name]) => name === "voice://dictation")?.[1];
    expect(listener).toBeDefined();
    act(() => listener!({ kind: "partial", generation: 51, text: "spoken" }));
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toHaveTextContent("spoken");
    act(() => view.dispatch({ changes: { from: 2, to: 4, insert: "XYZ" } }));
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    await waitFor(() => expect(cancelVoiceDictation).toHaveBeenCalledWith(51));
    act(() => listener!({ kind: "final", generation: 51, text: "late" }));
    expect(view.state.doc.toString()).toBe("abXYZef");
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });
  it("#2627 failed editor recording clears its ghost and rejects late Final", async () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    vi.mocked(getVoiceStatus).mockReset().mockResolvedValue(ready);
    vi.mocked(startVoiceDictation).mockReset().mockResolvedValue({ ...ready, accepted_generation: 54 });
    vi.mocked(cancelVoiceDictation).mockReset().mockResolvedValue(ready);
    vi.mocked(listenForBackendEvent).mockClear();
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "Authored source", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 8 } });
      publishVoiceStatus(ready);
    });
    fireEvent.click(mounted.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(startVoiceDictation).toHaveBeenCalledOnce());
    const listener = vi.mocked(listenForBackendEvent).mock.calls.find(([name]) => name === "voice://dictation")?.[1];
    expect(listener).toBeDefined();
    act(() => listener!({ kind: "partial", generation: 54, text: "provisional" }));
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toHaveTextContent("provisional");
    expect(view.state.doc.toString()).toBe("Authored source");
    expect(undoDepth(view.state)).toBe(0);
    act(() => listener!({ kind: "failed", generation: 54, reason: "inference_failed" }));
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    act(() => listener!({ kind: "final", generation: 54, text: "late" }));
    expect(view.state.doc.toString()).toBe("Authored source");
    expect(undoDepth(view.state)).toBe(0);
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });
  it("routes an accepted editor recording into its original selection", async () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    vi.mocked(getVoiceStatus).mockResolvedValue(ready);
    vi.mocked(cancelVoiceDictation).mockReset().mockResolvedValue(ready);
    let acceptStart!: (receipt: VoiceStatus & { accepted_generation: number }) => void;
    vi.mocked(startVoiceDictation).mockReturnValue(new Promise((resolve) => { acceptStart = resolve; }));
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "hello world", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 6, head: 11 } });
      publishVoiceStatus(ready);
    });
    fireEvent.click(mounted.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(startVoiceDictation).toHaveBeenCalledOnce());
    const listener = vi.mocked(listenForBackendEvent).mock.calls.find(([name]) => name === "voice://dictation")?.[1];
    expect(listener).toBeDefined();
    act(() => {
      listener!({ kind: "recording", generation: 42 });
      listener!({ kind: "partial", generation: 42, text: "spoken" });
      view.dispatch({ selection: { anchor: 0 } });
    });
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    await act(async () => acceptStart({ ...ready, accepted_generation: 42 }));
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toHaveTextContent("spoken");
    act(() => listener!({ kind: "final", generation: 42, text: "voice" }));
    expect(view.state.doc.toString()).toBe("hello voice");
    await act(async () => {});
    expect(cancelVoiceDictation).not.toHaveBeenCalled();
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe("hello world");
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });

  it("retires active editor dictation when Rich text becomes read-only", async () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    vi.mocked(getVoiceStatus).mockResolvedValue(ready);
    vi.mocked(cancelVoiceDictation).mockReset().mockResolvedValue(ready);
    vi.mocked(startVoiceDictation).mockReset().mockResolvedValue({ ...ready, accepted_generation: 43 });
    vi.mocked(listenForBackendEvent).mockClear();
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "hello world", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 6 } });
      publishVoiceStatus(ready);
    });
    fireEvent.click(mounted.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(startVoiceDictation).toHaveBeenCalledOnce());
    const listener = vi.mocked(listenForBackendEvent).mock.calls.find(([name]) => name === "voice://dictation")?.[1];
    expect(listener).toBeDefined();
    act(() => listener!({ kind: "partial", generation: 43, text: "spoken" }));
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toHaveTextContent("spoken");
    act(() => view.dispatch({ effects: setDisplayMode.of("None") }));
    expect(mounted.getByRole("button", { name: "Dictate — unavailable in this display mode" })).toBeDisabled();
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    await waitFor(() => expect(cancelVoiceDictation).toHaveBeenCalledWith(43));
    act(() => listener!({ kind: "final", generation: 43, text: "late" }));
    act(() => view.dispatch({ effects: setDisplayMode.of("All") }));
    expect(view.state.doc.toString()).toBe("hello world");
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });

  it("captures the editor target after first-use model download", async () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    let finishDownload!: () => void;
    vi.mocked(downloadVoiceModel).mockReset().mockReturnValue(new Promise<void>((resolve) => { finishDownload = resolve; }));
    vi.mocked(getVoiceStatus).mockReset().mockResolvedValue(ready);
    vi.mocked(startVoiceDictation).mockReset().mockResolvedValue({ ...ready, accepted_generation: 44 });
    vi.mocked(cancelVoiceDictation).mockReset().mockResolvedValue(ready);
    vi.mocked(listenForBackendEvent).mockClear();
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "hello world", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 6, head: 11 } });
      publishVoiceStatus({ ...ready, model: "missing" });
    });
    fireEvent.click(mounted.getByRole("button", { name: "Dictate — voice model missing" }));
    await waitFor(() => expect(downloadVoiceModel).toHaveBeenCalledOnce());
    expect(startVoiceDictation).not.toHaveBeenCalled();
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    await act(async () => finishDownload());
    await waitFor(() => expect(startVoiceDictation).toHaveBeenCalledOnce());
    const listener = vi.mocked(listenForBackendEvent).mock.calls.find(([name]) => name === "voice://dictation")?.[1];
    expect(listener).toBeDefined();
    act(() => listener!({ kind: "final", generation: 44, text: "Voice " }));
    expect(view.state.doc.toString()).toBe("Voice hello world");
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });

  it("does not start after the editor retires during first-use download", async () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    let finishDownload!: () => void;
    vi.mocked(downloadVoiceModel).mockReset().mockReturnValue(new Promise<void>((resolve) => { finishDownload = resolve; }));
    vi.mocked(getVoiceStatus).mockReset().mockResolvedValue(ready);
    vi.mocked(startVoiceDictation).mockReset().mockResolvedValue({ ...ready, accepted_generation: 45 });
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "hello world", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 6 } });
      publishVoiceStatus({ ...ready, model: "missing" });
    });
    fireEvent.click(mounted.getByRole("button", { name: "Dictate — voice model missing" }));
    await waitFor(() => expect(downloadVoiceModel).toHaveBeenCalledOnce());
    act(() => surface.current!.retireDictationTarget());
    await act(async () => finishDownload());
    expect(startVoiceDictation).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("hello world");
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });

  it("preserves another voice origin when the editor target retires", async () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    const chat = vi.fn<(event: VoiceDictationEvent) => void>();
    vi.mocked(getVoiceStatus).mockReset().mockResolvedValue(ready);
    vi.mocked(startVoiceDictation).mockReset().mockResolvedValue({ ...ready, accepted_generation: 46 });
    vi.mocked(cancelVoiceDictation).mockReset().mockResolvedValue(ready);
    vi.mocked(listenForBackendEvent).mockClear();
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<><SharedDictationMic onDictationEvent={chat} /><DocumentSurface ref={surface} platform="win" /></>);
    act(() => {
      surface.current!.mount({ content: "hello world", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      publishVoiceStatus(ready);
    });
    fireEvent.click(mounted.getAllByRole("button", { name: "Dictate" })[0]);
    await waitFor(() => expect(startVoiceDictation).toHaveBeenCalledOnce());
    act(() => surface.current!.retireDictationTarget());
    expect(cancelVoiceDictation).not.toHaveBeenCalled();
    const listener = vi.mocked(listenForBackendEvent).mock.calls.find(([name]) => name === "voice://dictation")?.[1];
    expect(listener).toBeDefined();
    act(() => listener!({ kind: "final", generation: 46, text: "chat text" }));
    expect(chat).toHaveBeenCalledWith({ kind: "final", generation: 46, text: "chat text" });
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });

  it("rejects an old Final after the CM6 surface remounts", async () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    vi.mocked(getVoiceStatus).mockReset().mockResolvedValue(ready);
    vi.mocked(startVoiceDictation).mockReset().mockResolvedValue({ ...ready, accepted_generation: 47 });
    vi.mocked(cancelVoiceDictation).mockReset().mockResolvedValue(ready);
    vi.mocked(listenForBackendEvent).mockClear();
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    act(() => {
      const original = surface.current!.mount({ content: "old text", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      original.dispatch({ selection: { anchor: 4 } });
      publishVoiceStatus(ready);
    });
    fireEvent.click(mounted.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(startVoiceDictation).toHaveBeenCalledOnce());
    const listener = vi.mocked(listenForBackendEvent).mock.calls.find(([name]) => name === "voice://dictation")?.[1];
    expect(listener).toBeDefined();
    act(() => listener!({ kind: "partial", generation: 47, text: "spoken" }));
    let replacement!: EditorView;
    act(() => {
      replacement = surface.current!.mount({ content: "new text", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
    });
    await waitFor(() => expect(cancelVoiceDictation).toHaveBeenCalledWith(47));
    act(() => listener!({ kind: "final", generation: 47, text: "late" }));
    expect(replacement.state.doc.toString()).toBe("new text");
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });
  it("replaces the original selected range after a delayed Begin", () => {
    const onDocumentChange = vi.fn();
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "hello world", parseDocument: null,
        parseGeneration: null, onDocumentChange });
      view.dispatch({ effects: setSourceView.of(true), selection: { anchor: 6, head: 11 } });
      expect(surface.current!.captureDictationTarget()).toBe(true);
      view.dispatch({ changes: { from: 0, insert: "new " } });
      view.dispatch({ selection: { anchor: 0 } });
      expect(surface.current!.beginDictation(21)).toBe(true);
      expect(surface.current!.showDictationPartial(21, "provisional")).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("new hello world");
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toHaveTextContent("provisional");
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    act(() => expect(surface.current!.commitDictationFinal(21, "voice")).toBe(true));
    expect(view.state.doc.toString()).toBe("new hello voice");
    expect(onDocumentChange).toHaveBeenCalledTimes(2);
    act(() => expect(undo(view)).toBe(true));
    expect(view.state.doc.toString()).toBe("new hello world");
  });

  it("discards a captured range when the accepted target becomes read-only", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abc def", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 0, head: 3 } });
      expect(surface.current!.captureDictationTarget()).toBe(true);
      view.dispatch({ effects: setDisplayMode.of("None") });
      expect(surface.current!.beginDictation(22)).toBe(false);
      view.dispatch({ effects: setDisplayMode.of("All"), selection: { anchor: 7 } });
      expect(surface.current!.beginDictation(23)).toBe(true);
      expect(surface.current!.commitDictationFinal(23, "X")).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("abc defX");
    mounted.unmount();
  });

  it("disables only the editor mic in read-only rich projections", () => {
    const ready: VoiceStatus = {
      enabled: true, selected_device_id: null, selected_device_name: null,
      devices: [{ id: "desk", name: "Desk", is_default: true }], device_issue: null,
      model: "ready", model_origin: "managed", external_model_path: null, download: { kind: "idle" }, download_revision: 0, capture_active: false,
      inference_available: true, dictation: { kind: "idle" }, dictation_generation: null,
    };
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "abc", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      publishVoiceStatus(ready);
    });
    expect(mounted.getByRole("button", { name: "Dictate" })).toBeEnabled();
    act(() => view.dispatch({ effects: setDisplayMode.of("None") }));
    expect(mounted.getByRole("button", { name: "Dictate — unavailable in this display mode" })).toBeDisabled();
    act(() => view.dispatch({ effects: setDisplayMode.of("Original") }));
    expect(mounted.getByRole("button", { name: "Dictate — unavailable in this display mode" })).toBeDisabled();
    act(() => view.dispatch({ effects: setDisplayMode.of("All") }));
    expect(mounted.getByRole("button", { name: "Dictate" })).toBeEnabled();
    act(() => view.dispatch({ effects: setSourceView.of(true), selection: { anchor: 1 } }));
    expect(mounted.getByRole("button", { name: "Dictate" })).toBeEnabled();
    mounted.unmount();
    act(() => invalidateVoiceStatus());
  });

  it("keeps the original target and partial on repeated Begin", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({
        content: "hello world",
        parseDocument: null,
        parseGeneration: null,
        onDocumentChange: vi.fn(),
      });
      view.dispatch({ selection: { anchor: 6 } });
      expect(surface.current!.beginDictation(17)).toBe(true);
      expect(surface.current!.showDictationPartial(17, "provisional")).toBe(true);
      view.dispatch({ selection: { anchor: 11 } });
      expect(surface.current!.beginDictation(17)).toBe(true);
    });
    const ghost = mounted.container.querySelector<HTMLElement>(".cm-dictation-ghost");
    expect(ghost).toHaveTextContent("provisional");
    expect(view.posAtDOM(ghost!)).toBe(6);
    act(() => expect(surface.current!.commitDictationFinal(17, "voice")).toBe(true));
    expect(view.state.doc.toString()).toBe("hello voiceworld");
  });

  it("rejects an older Begin after a newer generation owns the ghost", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({
        content: "hello world",
        parseDocument: null,
        parseGeneration: null,
        onDocumentChange: vi.fn(),
      });
      view.dispatch({ selection: { anchor: 6 } });
      expect(surface.current!.beginDictation(17)).toBe(true);
      view.dispatch({ selection: { anchor: 11 } });
      expect(surface.current!.beginDictation(18)).toBe(true);
      expect(surface.current!.showDictationPartial(18, "newer partial")).toBe(true);
      view.dispatch({ selection: { anchor: 2 } });
      expect(surface.current!.beginDictation(17)).toBe(false);
    });
    const ghost = mounted.container.querySelector<HTMLElement>(".cm-dictation-ghost");
    expect(ghost).toHaveTextContent("newer partial");
    expect(view.posAtDOM(ghost!)).toBe(11);
    act(() => expect(surface.current!.commitDictationFinal(17, "stale")).toBe(false));
    act(() => expect(surface.current!.commitDictationFinal(18, "voice")).toBe(true));
    expect(view.state.doc.toString()).toBe("hello worldvoice");
  });

  it("retains the generation floor after Clear", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "hello world", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 6 } });
      expect(surface.current!.beginDictation(18)).toBe(true);
      expect(surface.current!.showDictationPartial(18, "retired")).toBe(true);
      expect(surface.current!.clearDictation(18)).toBe(true);
      view.dispatch({ selection: { anchor: 11 } });
      expect(surface.current!.beginDictation(17)).toBe(false);
      expect(surface.current!.beginDictation(18)).toBe(false);
      expect(surface.current!.showDictationPartial(18, "late")).toBe(false);
      expect(surface.current!.commitDictationFinal(18, "stale")).toBe(false);
    });
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(view.state.doc.toString()).toBe("hello world");
    act(() => {
      expect(surface.current!.beginDictation(19)).toBe(true);
      expect(surface.current!.commitDictationFinal(19, "voice")).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("hello worldvoice");
  });

  it("retains the generation floor after Final", () => {
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({ content: "hello world", parseDocument: null,
        parseGeneration: null, onDocumentChange: vi.fn() });
      view.dispatch({ selection: { anchor: 6 } });
      expect(surface.current!.beginDictation(18)).toBe(true);
      expect(surface.current!.commitDictationFinal(18, "B")).toBe(true);
      view.dispatch({ selection: { anchor: 2 } });
      expect(surface.current!.beginDictation(17)).toBe(false);
      expect(surface.current!.beginDictation(18)).toBe(false);
      expect(surface.current!.commitDictationFinal(18, "stale")).toBe(false);
    });
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(view.state.doc.toString()).toBe("hello Bworld");
    act(() => {
      expect(surface.current!.beginDictation(19)).toBe(true);
      expect(surface.current!.commitDictationFinal(19, "C")).toBe(true);
    });
    expect(view.state.doc.toString()).toBe("heCllo Bworld");
  });

  it("retires an older ghost when a newer Begin has a read-only target", () => {
      const surface = createRef<DocumentSurfaceHandle>();
      const mounted = render(<DocumentSurface ref={surface} platform="win" />);
      let view!: EditorView;
      act(() => {
        view = surface.current!.mount({ content: "hello world", parseDocument: null,
          parseGeneration: null, onDocumentChange: vi.fn() });
        view.dispatch({ selection: { anchor: 6 } });
        expect(surface.current!.beginDictation(18)).toBe(true);
        expect(surface.current!.showDictationPartial(18, "older partial")).toBe(true);
        view.dispatch({ effects: setDisplayMode.of("None") });
        expect(view.state.readOnly).toBe(true);
        expect(surface.current!.beginDictation(19)).toBe(false);
        expect(surface.current!.showDictationPartial(18, "late partial")).toBe(false);
        expect(surface.current!.commitDictationFinal(18, "stale")).toBe(false);
      });
      expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
      expect(view.state.doc.toString()).toBe("hello world");
      act(() => {
        view.dispatch({ effects: setDisplayMode.of("All") });
        view.dispatch({ selection: { anchor: 2 } });
        expect(surface.current!.beginDictation(20)).toBe(true);
        expect(surface.current!.commitDictationFinal(20, "D")).toBe(true);
      });
      expect(view.state.doc.toString()).toBe("heDllo world");
      mounted.unmount();
  });

  it("shows an anchored ghost without changing source or undo in both projections", () => {
    for (const projection of ["rich", "markdown"] as const) {
      const onDocumentChange = vi.fn();
      const surface = createRef<DocumentSurfaceHandle>();
      const mounted = render(<DocumentSurface ref={surface} platform="win" />);
      let view!: EditorView;
      act(() => {
        view = surface.current!.mount({
          content: "hello world",
          parseDocument: null,
          parseGeneration: null,
          onDocumentChange,
        });
        if (projection === "markdown") view.dispatch({ effects: setSourceView.of(true) });
        view.dispatch({ selection: { anchor: 6 } });
      });
      const originalSource = view.state.doc.toString();
      const originalUndoDepth = undoDepth(view.state);

      act(() => {
        expect(surface.current!.beginDictation(17)).toBe(true);
        expect(surface.current!.showDictationPartial(17, "first guess")).toBe(true);
        expect(surface.current!.showDictationPartial(17, "corrected words")).toBe(true);
      });
      const ghost = mounted.container.querySelector<HTMLElement>(".cm-dictation-ghost");
      expect(ghost).not.toBeNull();
      expect(ghost).toHaveTextContent("corrected words");
      expect(mounted.container).not.toHaveTextContent("first guess");
      expect(view.posAtDOM(ghost!)).toBe(6);
      expect(view.state.doc.toString()).toBe(originalSource);
      expect(undoDepth(view.state)).toBe(originalUndoDepth);
      expect(onDocumentChange).not.toHaveBeenCalled();

      act(() => view.dispatch({ selection: { anchor: 11 } }));
      expect(view.posAtDOM(ghost!)).toBe(6);
      expect(view.state.doc.toString()).toBe(originalSource);
      mounted.unmount();
    }
  });

  it("maps the original target through edits and clears without another source change", () => {
    const onDocumentChange = vi.fn();
    const surface = createRef<DocumentSurfaceHandle>();
    const mounted = render(<DocumentSurface ref={surface} platform="win" />);
    let view!: EditorView;
    act(() => {
      view = surface.current!.mount({
        content: "hello world",
        parseDocument: null,
        parseGeneration: null,
        onDocumentChange,
      });
      view.dispatch({ selection: { anchor: 6 } });
      expect(surface.current!.beginDictation(17)).toBe(true);
      expect(surface.current!.showDictationPartial(17, "spoken words")).toBe(true);
      view.dispatch({ changes: { from: 0, insert: "new " } });
      view.dispatch({ selection: { anchor: 0, head: 3 } });
    });
    const ghost = mounted.container.querySelector<HTMLElement>(".cm-dictation-ghost");
    expect(ghost).toHaveTextContent("spoken words");
    expect(view.posAtDOM(ghost!)).toBe(10);
    expect(view.state.doc.toString()).toBe("new hello world");
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    const editUndoDepth = undoDepth(view.state);

    act(() => {
      expect(surface.current!.showDictationPartial(99, "stale words")).toBe(false);
      expect(surface.current!.clearDictation(99)).toBe(false);
    });
    expect(ghost).toHaveTextContent("spoken words");
    act(() => expect(surface.current!.clearDictation(17)).toBe(true));
    expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
    expect(view.state.doc.toString()).toBe("new hello world");
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(undoDepth(view.state)).toBe(editUndoDepth);
  });

  it("commits only a matched final as one independent undo step", () => {
    for (const projection of ["rich", "markdown"] as const) {
      const onDocumentChange = vi.fn();
      const surface = createRef<DocumentSurfaceHandle>();
      const mounted = render(<DocumentSurface ref={surface} platform="win" />);
      let view!: EditorView;
      act(() => {
        view = surface.current!.mount({
          content: "hello world",
          parseDocument: { root: "/project", path: "chapter.md" },
          parseGeneration: "r1",
          onDocumentChange,
        });
        if (projection === "markdown") view.dispatch({ effects: setSourceView.of(true) });
        view.dispatch({ selection: { anchor: 6 } });
        expect(surface.current!.beginDictation(17)).toBe(true);
        expect(surface.current!.showDictationPartial(17, "provisional")).toBe(true);
        view.dispatch({ changes: { from: 0, insert: "new " } });
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      expect(onDocumentChange).toHaveBeenCalledTimes(1);
      const editUndoDepth = undoDepth(view.state);
      act(() => expect(surface.current!.commitDictationFinal(99, "wrong owner")).toBe(false));
      expect(view.state.doc.toString()).toBe("new hello world");
      expect(mounted.container.querySelector(".cm-dictation-ghost")).toHaveTextContent("provisional");

      act(() => expect(surface.current!.commitDictationFinal(17, "final words")).toBe(true));
      expect(view.state.doc.toString()).toBe("new hello final wordsworld");
      expect(mounted.container.querySelector(".cm-dictation-ghost")).toBeNull();
      expect(onDocumentChange).toHaveBeenCalledTimes(2);
      expect(onDocumentChange).toHaveBeenLastCalledWith("new hello final wordsworld");
      expect(undoDepth(view.state)).toBe(editUndoDepth + 1);
      act(() => expect(undo(view)).toBe(true));
      expect(view.state.doc.toString()).toBe("new hello world");
      mounted.unmount();
    }
  });
});

// @vitest-environment jsdom
// ABOUTME: The shared voice owner projects into every authored input surface and editor echo.
import { act, createRef } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocumentSurface, type DocumentSurfaceHandle } from "../editor/DocumentSurface";
import { MessageInput } from "../timeline/MessageInput";
import { CommentComposer } from "../comments/CommentComposer";
import type { VoiceStatus } from "../settings/voiceIpc";
import { publishVoiceStatus, VoiceSettingsOpenContext } from "./SharedDictationMic";

vi.mock("../editor/ipc", async (importActual) => {
  const actual = await importActual<typeof import("../editor/ipc")>();
  return { ...actual, parseChanges: vi.fn().mockResolvedValue([]) };
});

const ready: VoiceStatus = {
  enabled: true,
  selected_device_id: null,
  selected_device_name: null,
  devices: [{ id: "desk", name: "Desk", is_default: true }],
  device_issue: null,
  model: "ready",
  model_origin: "managed",
  external_model_path: null,
  download: { kind: "idle" },
  download_revision: 0,
  capture_active: false,
  inference_available: true,
  dictation: { kind: "idle" },
  dictation_generation: null,
};

describe("voice/three input surfaces", () => {
  it("#2635 routes editor, Timeline, and comment error mics to the same Voice Settings opener", () => {
    const ref = createRef<DocumentSurfaceHandle>();
    const open = vi.fn();
    const send = vi.fn();
    const comment = vi.fn();
    render(<VoiceSettingsOpenContext.Provider value={open}>
      <DocumentSurface ref={ref} platform="win" />
      <MessageInput onSubmit={send} />
      <CommentComposer selection={null} onSubmit={comment} />
    </VoiceSettingsOpenContext.Provider>);
    act(() => { ref.current!.mount({ content: "Source", parseDocument: null, parseGeneration: null }); });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Chat draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "Comment draft" } });
    act(() => publishVoiceStatus({ ...ready, device_issue: "selected_unavailable" }));
    const mics = screen.getAllByRole("button", { name: "Dictate — selected microphone unavailable" });
    expect(mics).toHaveLength(3);
    for (const mic of mics) fireEvent.click(mic);
    expect(open.mock.calls.map(([trigger]) => trigger)).toEqual(mics);
    expect(ref.current!.view()!.state.doc.toString()).toBe("Source");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("Chat draft");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("Comment draft");
    expect(send).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
    act(() => publishVoiceStatus(ready));
  });

  it("#2627 three surfaces keep authored text through typed voice failures", () => {
    const ref = createRef<DocumentSurfaceHandle>();
    const send = vi.fn();
    const comment = vi.fn();
    render(<>
      <DocumentSurface ref={ref} platform="win" />
      <MessageInput onSubmit={send} />
      <CommentComposer selection={null} onSubmit={comment} />
    </>);
    act(() => { ref.current!.mount({ content: "Authored source", parseDocument: null, parseGeneration: null }); });
    const chatDraft = screen.getByRole("textbox", { name: "Message" });
    const commentDraft = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(chatDraft, { target: { value: "Authored chat" } });
    fireEvent.change(commentDraft, { target: { value: "Authored comment" } });

    const failures: { status: VoiceStatus; label: string; echo: string }[] = [
      { status: { ...ready, device_issue: "no_device" }, label: "Dictate — no microphone found", echo: "No microphone found" },
      { status: { ...ready, device_issue: "no_default_device" }, label: "Dictate — no default microphone available", echo: "No default microphone is available" },
      { status: { ...ready, device_issue: "selected_unavailable" }, label: "Dictate — selected microphone unavailable", echo: "Selected microphone is unavailable" },
      { status: { ...ready, device_issue: "permission_denied" }, label: "Dictate — microphone permission denied", echo: "Microphone access is off" },
      { status: { ...ready, device_issue: "backend_unavailable" }, label: "Dictate — microphone access unavailable", echo: "Microphone access is unavailable" },
      { status: { ...ready, model: "missing" }, label: "Dictate — voice model missing", echo: "Voice model is missing" },
      { status: { ...ready, model: "corrupt" }, label: "Dictate — voice model is corrupt", echo: "Voice model is corrupt" },
      { status: { ...ready, download: { kind: "failed", reason: "transport" } }, label: "Dictate — voice model download failed", echo: "Voice model download failed" },
      { status: { ...ready, dictation: { kind: "error", reason: "invalid_audio" } }, label: "Dictate — recording could not be read", echo: "Recording could not be read" },
      { status: { ...ready, dictation: { kind: "error", reason: "inference_failed" } }, label: "Dictate — dictation failed", echo: "Dictation failed" },
    ];
    for (const { status, label, echo } of failures) {
      act(() => publishVoiceStatus(status));
      const buttons = screen.getAllByRole("button", { name: label });
      expect(buttons).toHaveLength(3);
      expect(screen.getByText(echo)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop dictation — recording" })).toBeNull();
      expect(ref.current!.view()!.state.doc.toString()).toBe("Authored source");
      expect(chatDraft).toHaveValue("Authored chat");
      expect(commentDraft).toHaveValue("Authored comment");
    }
    for (const { status, label } of [
      { status: { ...ready, inference_available: false, download: { kind: "cancelled", downloaded: 20, total: 100 } } as VoiceStatus,
        label: "Dictate — unavailable in this build" },
      { status: { ...ready, enabled: false, download: { kind: "cancelled", downloaded: 20, total: 100 } } as VoiceStatus,
        label: "Dictate — voice is off in Settings" },
    ]) {
      act(() => publishVoiceStatus(status));
      const buttons = screen.getAllByRole("button", { name: label });
      expect(buttons).toHaveLength(3);
      for (const button of buttons) expect(button).toBeDisabled();
      expect(screen.queryByText("Dictation failed")).toBeNull();
      expect(ref.current!.view()!.state.doc.toString()).toBe("Authored source");
      expect(chatDraft).toHaveValue("Authored chat");
      expect(commentDraft).toHaveValue("Authored comment");
    }
    act(() => publishVoiceStatus(ready));
    expect(screen.getAllByRole("button", { name: "Dictate" })).toHaveLength(3);
    expect(send).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  it("keeps a pinned editor mic, both composer mics, and the left status echo on one backend phase", () => {
    const ref = createRef<DocumentSurfaceHandle>();
    render(<>
      <DocumentSurface ref={ref} platform="win" />
      <MessageInput onSubmit={vi.fn()} />
      <CommentComposer selection={null} onSubmit={vi.fn()} />
    </>);
    act(() => { ref.current!.mount({ content: "Draft", parseDocument: null, parseGeneration: null }); });
    act(() => publishVoiceStatus({ ...ready, model: "absent", download: { kind: "progress", downloaded: 42, total: 100 } }));
    expect(screen.getAllByRole("button", { name: "Dictate — downloading voice model, 42%" })).toHaveLength(3);
    const toolbar = screen.getByRole("toolbar", { name: "Editor view controls" });
    const editorMic = within(toolbar).getByRole("button", { name: /Dictate/ });
    expect(editorMic.closest("[data-toolbar-control]")).toBeNull();
    expect(screen.getByText("Downloading voice model · 42%")).toBeInTheDocument();

    act(() => publishVoiceStatus({ ...ready, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 7 } }));
    expect(screen.getAllByRole("button", { name: "Stop dictation — recording" })).toHaveLength(3);
    expect(screen.getByText("Recording · 0:07")).toBeInTheDocument();
    fireEvent.click(within(toolbar).getByRole("button", { name: "Markdown" }));
    expect(within(toolbar).getByRole("button", { name: "Stop dictation — recording" })).toBeVisible();
    act(() => ref.current!.setParseDocument({ root: "/project", path: "draft.md" }, "rev-a"));
    fireEvent.click(within(toolbar).getByRole("button", { name: "Rich text" }));
    expect(within(toolbar).getByRole("button", { name: "Stop dictation — recording" })).toBeVisible();
  });
});

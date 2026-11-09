// @vitest-environment jsdom
// ABOUTME: Draft-only voice events stay with the chat or comment composer that opened capture.
// ABOUTME: The typed backend/event seam is substituted while real composer forms remain mounted.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../timeline/MessageInput";
import { TimelinePanel } from "../timeline/TimelinePanel";
import { CommentComposer } from "../comments/CommentComposer";
import { DocumentSurface, type DocumentSurfaceHandle } from "../editor/DocumentSurface";
import type { VoiceStatus } from "../settings/voiceIpc";
import { publishVoiceStatus, retireVoiceStartIntent } from "./SharedDictationMic";

const bridge = vi.hoisted(() => ({
  getVoiceStatus: vi.fn(),
  downloadVoiceModel: vi.fn(),
  startVoiceDictation: vi.fn(),
  stopVoiceDictation: vi.fn(),
  cancelVoiceDictation: vi.fn(),
  listenForBackendEvent: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../settings/voiceIpc", () => ({
  getVoiceStatus: bridge.getVoiceStatus,
  downloadVoiceModel: bridge.downloadVoiceModel,
  startVoiceDictation: bridge.startVoiceDictation,
  stopVoiceDictation: bridge.stopVoiceDictation,
  cancelVoiceDictation: bridge.cancelVoiceDictation,
  VOICE_DOWNLOAD_EVENT: "voice://download",
  VOICE_DICTATION_EVENT: "voice://dictation",
}));
vi.mock("../stores/driverEvents", () => ({ listenForBackendEvent: bridge.listenForBackendEvent }));
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

describe("voice/composer draft", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    bridge.getVoiceStatus.mockReset().mockResolvedValue(ready);
    bridge.downloadVoiceModel.mockReset().mockResolvedValue(undefined);
    bridge.startVoiceDictation.mockReset().mockResolvedValue({
      ...ready, accepted_generation: 7, dictation_generation: 7,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    bridge.stopVoiceDictation.mockReset().mockResolvedValue(ready);
    bridge.cancelVoiceDictation.mockReset().mockResolvedValue(ready);
    bridge.listenForBackendEvent.mockClear();
    act(() => publishVoiceStatus(ready));
  });
  afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

  it("#2627 failed chat recording cannot leak into a later comment draft", async () => {
    const editor = createRef<DocumentSurfaceHandle>();
    const send = vi.fn();
    const commentSubmit = vi.fn();
    const recording = (generation: number) => ({
      ...ready, accepted_generation: generation, dictation_generation: generation,
      capture_active: true, dictation: { kind: "recording" as const, elapsed_seconds: 0 },
    });
    let ownerStatus: VoiceStatus = ready;
    bridge.getVoiceStatus.mockReset().mockImplementation(() => Promise.resolve(ownerStatus));
    bridge.startVoiceDictation.mockReset()
      .mockResolvedValueOnce(recording(7))
      .mockResolvedValueOnce(recording(8));
    render(<>
      <DocumentSurface ref={editor} platform="win" />
      <MessageInput onSubmit={send} />
      <CommentComposer selection={null} onSubmit={commentSubmit} />
    </>);
    act(() => { editor.current!.mount({ content: "Editor source", parseDocument: null, parseGeneration: null }); });
    const chat = screen.getByRole("textbox", { name: "Message" });
    const comment = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(chat, { target: { value: "Typed chat" } });
    fireEvent.change(comment, { target: { value: "Typed comment" } });
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(chat.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Stop dictation — recording" })).toHaveLength(3));
    const event = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => event({ kind: "partial", generation: 7, text: "spoken chat" }));
    expect(chat.closest("form")!.querySelector(".composer-dictation-partial")).toHaveTextContent("spoken chat");
    expect(comment.closest("form")!.querySelector(".composer-dictation-partial")).toBeEmptyDOMElement();

    ownerStatus = { ...ready, dictation: { kind: "error", reason: "inference_failed" } };
    act(() => {
      event({ kind: "failed", generation: 7, reason: "inference_failed" });
      publishVoiceStatus(ownerStatus);
    });
    expect(screen.getAllByRole("button", { name: "Dictate — dictation failed" })).toHaveLength(3);
    act(() => event({ kind: "partial", generation: 7, text: "late partial" }));
    expect(chat.closest("form")!.querySelector(".composer-dictation-partial")).toHaveTextContent("Dictation failed");
    expect(chat.closest("form")!.querySelector(".composer-dictation-partial")).not.toHaveTextContent("late partial");
    act(() => event({ kind: "final", generation: 7, text: "late chat" }));
    expect(chat).toHaveValue("Typed chat");
    expect(comment).toHaveValue("Typed comment");
    expect(editor.current!.view()!.state.doc.toString()).toBe("Editor source");

    ownerStatus = ready;
    act(() => publishVoiceStatus(ready));
    fireEvent.click(comment.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledTimes(2));
    act(() => event({ kind: "final", generation: 8, text: " recorded" }));
    expect(comment).toHaveValue("Typed comment recorded");
    expect(chat).toHaveValue("Typed chat");
    expect(editor.current!.view()!.state.doc.toString()).toBe("Editor source");
    expect(send).not.toHaveBeenCalled();
    expect(commentSubmit).not.toHaveBeenCalled();
  });

  it("#2550 replaces the chat selection captured at Start despite a later caret move", async () => {
    const send = vi.fn();
    render(<MessageInput onSubmit={send} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "Alpha old omega" } });
    message.setSelectionRange(6, 9);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    message.focus();
    message.setSelectionRange(0, 0);
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "new maybe" }));
    expect(message).toHaveValue("Alpha old omega");
    act(() => onEvent({ kind: "final", generation: 7, text: "new" }));
    expect(message).toHaveValue("Alpha new omega");
    expect(message).toHaveFocus();
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(message, { target: { value: "Alpha new omega!" } });
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".message-input__send")!);
    expect(send).toHaveBeenCalledExactlyOnceWith("Alpha new omega!");
  });

  it("#2550 maps a captured chat caret through a draft edit", async () => {
    render(<MessageInput onSubmit={vi.fn()} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "hello world" } });
    message.setSelectionRange(6, 6);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    message.setSelectionRange(0, 0);
    fireEvent(message, new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "new " }));
    fireEvent.input(message, { target: { value: "new hello world", selectionStart: 4, selectionEnd: 4 }, inputType: "insertText" });
    message.setSelectionRange(0, 0);
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "spoken " }));
    expect(message).toHaveValue("new hello spoken world");
  });

  it("#2550 maps repeated-text input at its actual edit range", async () => {
    render(<MessageInput onSubmit={vi.fn()} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "aaaa" } });
    message.setSelectionRange(2, 2);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());

    message.setSelectionRange(0, 0);
    fireEvent(message, new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "a" }));
    fireEvent.input(message, { target: { value: "aaaaa", selectionStart: 1, selectionEnd: 1 }, inputType: "insertText" });
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "X" }));
    expect(message).toHaveValue("aaaXaa");
  });

  it("#2550 retires an unknowable draft edit instead of guessing its target", async () => {
    render(<MessageInput onSubmit={vi.fn()} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "aaaa" } });
    message.setSelectionRange(2, 2);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());

    // An external value replacement has no browser beforeinput range to disambiguate repeated text.
    fireEvent.change(message, { target: { value: "aaaaa" } });
    await waitFor(() => expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(7));
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "X" }));
    expect(message).toHaveValue("aaaaa");
  });

  it("#2550 retires an orphaned beforeinput before a later unpaired edit", async () => {
    render(<MessageInput onSubmit={vi.fn()} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "aaaa" } });
    message.setSelectionRange(2, 2);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());

    vi.useFakeTimers();
    try {
      message.setSelectionRange(0, 0);
      fireEvent(message, new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "a" }));
      // The browser did not apply that edit. Its next task has no corresponding pre-edit range.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.input(message, { target: { value: "aaaaa", selectionStart: 1, selectionEnd: 1 }, inputType: "insertText" });
      expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(7);
      const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
      act(() => onEvent({ kind: "final", generation: 7, text: "X" }));
      expect(message).toHaveValue("aaaaa");
    } finally {
      vi.useRealTimers();
    }
  });

  it("#2550 captures the chat target when recording starts after download", async () => {
    const missing: VoiceStatus = { ...ready, model: "absent" };
    act(() => publishVoiceStatus(missing));
    bridge.getVoiceStatus.mockReset().mockResolvedValue(missing);
    let finishDownload!: () => void;
    bridge.downloadVoiceModel.mockReset().mockReturnValue(new Promise<void>((resolve) => { finishDownload = resolve; }));
    render(<MessageInput onSubmit={vi.fn()} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "hello world" } });
    message.setSelectionRange(0, 0);
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictate — voice model missing" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Dictate — voice model missing" }));
    await waitFor(() => expect(bridge.downloadVoiceModel).toHaveBeenCalledOnce());
    message.setSelectionRange(6, 6);
    bridge.getVoiceStatus.mockResolvedValue(ready);
    await act(async () => finishDownload());
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "voice " }));
    expect(message).toHaveValue("hello voice world");
  });

  it("#2550 inserts a comment Final at its captured caret without submitting", async () => {
    const submit = vi.fn();
    render(<CommentComposer selection={null} onSubmit={submit} />);
    const comment = screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
    fireEvent.change(comment, { target: { value: "The note remains" } });
    comment.setSelectionRange(4, 4);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(comment.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    comment.setSelectionRange(comment.value.length, comment.value.length);
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "spoken " }));
    expect(comment).toHaveValue("The spoken note remains");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(comment.closest("form")!.querySelector<HTMLButtonElement>(".comment-composer__submit")!);
    expect(submit).toHaveBeenCalledExactlyOnceWith("The spoken note remains");
  });

  it("#2550 replaces the comment selection captured before a later caret move", async () => {
    const submit = vi.fn();
    render(<CommentComposer selection={null} onSubmit={submit} />);
    const comment = screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
    fireEvent.change(comment, { target: { value: "The old note" } });
    comment.setSelectionRange(4, 7);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(comment.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    comment.setSelectionRange(comment.value.length, comment.value.length);
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "new" }));
    expect(comment).toHaveValue("The new note");
    expect(submit).not.toHaveBeenCalled();
  });

  it("#2550 drops a chat Final after origin retirement while preserving its typed draft", async () => {
    const send = vi.fn();
    render(<MessageInput onSubmit={send} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "typed words" } });
    message.setSelectionRange(6, 11);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    act(() => retireVoiceStartIntent());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "stale" }));
    expect(message).toHaveValue("typed words");
    expect(send).not.toHaveBeenCalled();
  });

  it("#2550 inserts Final only into the clicked composer when both drafts are mounted", async () => {
    const send = vi.fn();
    const commentSubmit = vi.fn();
    render(<><MessageInput onSubmit={send} /><CommentComposer selection={null} onSubmit={commentSubmit} /></>);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const comment = screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "chat draft" } });
    fireEvent.change(comment, { target: { value: "comment draft" } });
    message.setSelectionRange(5, 5);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "final", generation: 7, text: "voice " }));
    expect(message).toHaveValue("chat voice draft");
    expect(comment).toHaveValue("comment draft");
    expect(send).not.toHaveBeenCalled();
    expect(commentSubmit).not.toHaveBeenCalled();
  });

  it("#2550 keeps the chat draft provisional through Stop until Final arrives", async () => {
    const send = vi.fn();
    bridge.stopVoiceDictation.mockReset().mockResolvedValue({
      ...ready, dictation_generation: 7, dictation: { kind: "transcribing" },
    });
    render(<MessageInput onSubmit={send} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "Draft " } });
    message.setSelectionRange(6, 6);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "working" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation — recording" }));
    await waitFor(() => expect(bridge.stopVoiceDictation).toHaveBeenCalledOnce());
    expect(message).toHaveValue("Draft ");
    expect(screen.getByText("working")).toHaveAttribute("data-provisional", "true");
    act(() => onEvent({ kind: "final", generation: 7, text: "spoken" }));
    expect(message).toHaveValue("Draft spoken");
    expect(screen.queryByText("working")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("#2550 partial stays provisional in the originating chat composer and cannot be sent", async () => {
    const send = vi.fn();
    render(<><MessageInput onSubmit={send} /><CommentComposer selection={null} onSubmit={vi.fn()} /></>);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const chat = message.closest("form")!;
    fireEvent.change(message, { target: { value: "typed words" } });
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(within(chat).getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(within(chat).getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());

    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "spoken but unfinished" }));
    expect(within(chat).getByText("spoken but unfinished")).toHaveAttribute("data-provisional", "true");
    expect(message.value).toBe("typed words");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
    expect(screen.queryByText("spoken but unfinished", { selector: ".comment-composer *" })).toBeNull();

    fireEvent.click(within(chat).getByRole("button", { name: "Send" }));
    expect(send).toHaveBeenCalledWith("typed words");
    expect(message.value).toBe("");
    expect(within(chat).queryByText("spoken but unfinished")).toBeNull();
  });

  it("#2550 announces provisional speech in a stable chat live region", async () => {
    render(<MessageInput onSubmit={vi.fn()} />);
    const message = screen.getByRole("textbox", { name: "Message" });
    const liveRegion = message.closest("form")!.querySelector<HTMLElement>(".composer-dictation-partial")!;
    expect(liveRegion).toBeEmptyDOMElement();
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(liveRegion).not.toHaveAttribute("role");
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "first" }));
    expect(message.closest("form")!.querySelector(".composer-dictation-partial")).toBe(liveRegion);
    expect(liveRegion).toHaveAttribute("aria-atomic", "true");
    expect(liveRegion).toHaveTextContent("Provisional dictation: first");
    act(() => onEvent({ kind: "partial", generation: 7, text: "first words" }));
    expect(liveRegion).toHaveTextContent("Provisional dictation: first words");
    expect(message).toHaveValue("");
  });

  it("#2550 announces provisional speech in a stable comment live region", async () => {
    render(<CommentComposer selection={null} onSubmit={vi.fn()} />);
    const comment = screen.getByRole("textbox", { name: "Comment" });
    const liveRegion = comment.closest("form")!.querySelector<HTMLElement>(".composer-dictation-partial")!;
    expect(liveRegion).toBeEmptyDOMElement();
    expect(liveRegion).not.toHaveAttribute("role");
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(comment.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "review note" }));
    expect(comment.closest("form")!.querySelector(".composer-dictation-partial")).toBe(liveRegion);
    expect(liveRegion).toHaveTextContent("Provisional dictation: review note");
    expect(comment).toHaveValue("");
  });

  it("#2550 comment partial disappears on owner unmount and cannot leak into chat", async () => {
    const comment = render(<CommentComposer selection={null} onSubmit={vi.fn()} />);
    const form = screen.getByRole("textbox", { name: "Comment" }).closest("form")!;
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(within(form).getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(within(form).getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "comment thought" }));
    expect(within(form).getByText("comment thought")).toHaveAttribute("data-provisional", "true");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");

    comment.unmount();
    render(<MessageInput onSubmit={vi.fn()} />);
    act(() => onEvent({ kind: "partial", generation: 7, text: "late comment" }));
    expect(screen.queryByText("late comment")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("#2550 Cancel retires comment speech before the parent unmounts the form", async () => {
    const onCancel = vi.fn();
    render(<><CommentComposer selection={null} onSubmit={vi.fn()} onCancel={onCancel} /><MessageInput onSubmit={vi.fn()} /></>);
    const comment = screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
    const form = comment.closest("form")!;
    fireEvent.change(comment, { target: { value: "typed note" } });
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(within(form).getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(within(form).getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "unfinished note" }));
    expect(within(form).getByText("unfinished note")).toBeInTheDocument();

    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(7);
    expect(within(form).queryByText("unfinished note")).toBeNull();
    act(() => onEvent({ kind: "partial", generation: 7, text: "late speech" }));
    expect(within(form).queryByText("late speech")).toBeNull();
    expect(comment.value).toBe("typed note");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  });

  it("#2550 collapsing Timeline retires the still-mounted chat composer", async () => {
    const { rerender } = render(<TimelinePanel collapsed={false} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "typed words" } });
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "unsent speech" }));
    expect(screen.getByText("unsent speech")).toHaveAttribute("data-provisional", "true");

    rerender(<TimelinePanel collapsed />);
    expect(bridge.cancelVoiceDictation).toHaveBeenCalledExactlyOnceWith(7);
    expect(screen.queryByText("unsent speech")).toBeNull();
    act(() => onEvent({ kind: "partial", generation: 7, text: "late words" }));
    rerender(<TimelinePanel collapsed={false} />);
    expect(screen.queryByText("late words")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("typed words");
  });

  it("#2550 retires before a same-commit collapse Final", async () => {
    let deliverFinal: (() => void) | null = null;
    function Harness({ collapsed }: { collapsed: boolean }) {
      useLayoutEffect(() => { if (collapsed) deliverFinal?.(); }, [collapsed]);
      return <MessageInput onSubmit={vi.fn()} dictationActive={!collapsed} />;
    }
    const mounted = render(<Harness collapsed={false} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "typed words" } });
    message.setSelectionRange(6, 11);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    deliverFinal = () => onEvent({ kind: "final", generation: 7, text: "stale" });
    mounted.rerender(<Harness collapsed />);
    expect(message).toHaveValue("typed words");
  });

  it("#2550 retires before a same-commit tab Final", async () => {
    let deliverFinal: (() => void) | null = null;
    function Harness({ identity }: { identity: string }) {
      useLayoutEffect(() => { if (identity === "tab-b") deliverFinal?.(); }, [identity]);
      return <MessageInput onSubmit={vi.fn()} dictationIdentity={identity} />;
    }
    const mounted = render(<Harness identity="tab-a" />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "typed words" } });
    message.setSelectionRange(6, 11);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    deliverFinal = () => onEvent({ kind: "final", generation: 7, text: "stale" });
    mounted.rerender(<Harness identity="tab-b" />);
    expect(message).toHaveValue("typed words");
  });

  it("#2550 threads the active tab identity through Timeline's mounted composer", async () => {
    let deliverFinal: (() => void) | null = null;
    function Harness({ path }: { path: string }) {
      useLayoutEffect(() => { if (path === "chapter-b.md") deliverFinal?.(); }, [path]);
      return <TimelinePanel commentPath={path} />;
    }
    const mounted = render(<Harness path="chapter-a.md" />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "typed words" } });
    message.setSelectionRange(6, 11);
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledOnce());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    deliverFinal = () => onEvent({ kind: "final", generation: 7, text: "stale" });
    mounted.rerender(<Harness path="chapter-b.md" />);
    expect(message).toHaveValue("typed words");
  });

  it("#2550 tab retirement clears a still-mounted chat provisional span", async () => {
    render(<MessageInput onSubmit={vi.fn()} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "typed words" } });
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "before switch" }));
    expect(screen.getByText("before switch")).toHaveAttribute("data-provisional", "true");

    act(() => retireVoiceStartIntent());
    expect(screen.queryByText("before switch")).toBeNull();
    expect(message).toHaveValue("typed words");
    act(() => onEvent({ kind: "partial", generation: 7, text: "late words" }));
    expect(screen.queryByText("late words")).toBeNull();
  });

  it("#2550 failure clears provisional speech without changing draft or focus", async () => {
    const send = vi.fn();
    render(<MessageInput onSubmit={send} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "keep my words" } });
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    message.focus();
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    act(() => onEvent({ kind: "partial", generation: 7, text: "do not keep" }));
    expect(screen.getByText("do not keep")).toHaveAttribute("data-provisional", "true");
    act(() => onEvent({ kind: "failed", generation: 7, reason: "inference_failed" }));
    expect(screen.queryByText("do not keep")).toBeNull();
    expect(message).toHaveValue("keep my words");
    expect(message).toHaveFocus();
    expect(send).not.toHaveBeenCalled();
  });

  it("#2651 composer error echo replaces chat provisional speech without changing the draft", async () => {
    const send = vi.fn();
    render(<MessageInput onSubmit={send} />);
    const message = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "Keep this draft" } });
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    message.focus();
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    const slot = message.closest("form")!.querySelector<HTMLElement>(".composer-dictation-partial")!;
    act(() => onEvent({ kind: "partial", generation: 7, text: "unfinished speech" }));
    expect(slot).toHaveTextContent("unfinished speech");
    act(() => onEvent({ kind: "failed", generation: 7, reason: "inference_failed" }));
    expect(slot).toHaveTextContent("Dictation failed");
    expect(slot).not.toHaveTextContent("unfinished speech");
    expect(slot).toHaveAttribute("data-error", "true");
    expect(message).toHaveValue("Keep this draft");
    expect(message).toHaveFocus();
    expect(send).not.toHaveBeenCalled();

    bridge.startVoiceDictation.mockResolvedValueOnce({
      ...ready, accepted_generation: 8, dictation_generation: 8,
      capture_active: true, dictation: { kind: "recording", elapsed_seconds: 0 },
    });
    act(() => publishVoiceStatus(ready));
    fireEvent.click(message.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(bridge.startVoiceDictation).toHaveBeenCalledTimes(2));
    expect(slot).toHaveAttribute("data-error", "false");
    expect(slot).toBeEmptyDOMElement();
    act(() => onEvent({ kind: "failed", generation: 7, reason: "inference_failed" }));
    expect(slot).toBeEmptyDOMElement();
    act(() => onEvent({ kind: "partial", generation: 8, text: "new speech" }));
    expect(slot).toHaveTextContent("new speech");
    expect(message).toHaveValue("Keep this draft");
  });

  it("#2651 composer error echo replaces comment provisional speech and ignores a late partial", async () => {
    const submit = vi.fn();
    render(<CommentComposer selection={null} onSubmit={submit} />);
    const comment = screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
    fireEvent.change(comment, { target: { value: "Keep this comment" } });
    await waitFor(() => expect(bridge.listenForBackendEvent).toHaveBeenCalledWith("voice://dictation", expect.any(Function)));
    fireEvent.click(comment.closest("form")!.querySelector<HTMLButtonElement>(".dictation-mic")!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop dictation — recording" })).toBeEnabled());
    const onEvent = bridge.listenForBackendEvent.mock.calls.find(([name]) => name === "voice://dictation")![1];
    const slot = comment.closest("form")!.querySelector<HTMLElement>(".composer-dictation-partial")!;
    act(() => onEvent({ kind: "partial", generation: 7, text: "unfinished note" }));
    act(() => onEvent({ kind: "failed", generation: 7, reason: "invalid_audio" }));
    expect(slot).toHaveTextContent("Recording could not be read");
    expect(slot).toHaveAttribute("aria-live", "assertive");
    expect(slot).toHaveAttribute("data-error", "true");
    act(() => onEvent({ kind: "partial", generation: 7, text: "late words" }));
    expect(slot).not.toHaveTextContent("late words");
    expect(comment).toHaveValue("Keep this comment");
    expect(submit).not.toHaveBeenCalled();
  });
});

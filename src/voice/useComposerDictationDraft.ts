// ABOUTME: Keeps live speech provisional and separate from a chat or comment form's editable value.
// ABOUTME: A terminal transcript changes only the origin's draft at its captured selection.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { VoiceDictationEvent } from "../settings/voiceIpc";
import { voiceStatusEcho } from "./voicePresentation";

type DraftTarget = { start: number; end: number };
type PendingInput = DraftTarget & { previous: string; inputType: string };

function mapTarget(target: DraftTarget, start: number, oldEnd: number, newEnd: number): DraftTarget {
  const map = (position: number, afterInsertion: boolean) => {
    if (position < start) return position;
    if (position > oldEnd) return position + newEnd - oldEnd;
    if (position === start && position === oldEnd) return afterInsertion ? newEnd : start;
    if (position === start) return start;
    if (position === oldEnd) return newEnd;
    return afterInsertion ? newEnd : start;
  };
  if (target.start === target.end) {
    const caret = map(target.start, true);
    return { start: caret, end: caret };
  }
  return { start: map(target.start, true), end: map(target.end, false) };
}

function verifiedInputRange(previous: string, next: string, input: PendingInput | null, inputType: string | undefined):
    { start: number; oldEnd: number; newEnd: number } | null {
  if (!input || input.previous !== previous || input.inputType !== inputType ||
      !["insertText", "insertFromPaste", "insertFromDrop", "insertLineBreak", "insertParagraph",
        "deleteByCut", "deleteContentBackward", "deleteContentForward"].includes(input.inputType)) return null;
  let { start, end } = input;
  if (start < 0 || end < start || end > previous.length) return null;
  // A collapsed deletion has no selected range before the browser applies it. Its direction
  // and actual removed length come from the native beforeinput type and resulting value.
  if (start === end && input.inputType.startsWith("delete")) {
    const removed = previous.length - next.length;
    if (removed < 0) return null;
    if (input.inputType === "deleteContentBackward") start -= removed;
    else if (input.inputType === "deleteContentForward") end += removed;
    else return null;
  }
  const insertedLength = next.length - previous.length + end - start;
  const newEnd = start + insertedLength;
  if (start < 0 || end > previous.length || insertedLength < 0 ||
      next.slice(0, start) !== previous.slice(0, start) ||
      next.slice(newEnd) !== previous.slice(end)) return null;
  return { start, oldEnd: end, newEnd };
}

export function useComposerDictationDraft() {
  const [value, setValue] = useState("");
  const [partial, setPartial] = useState("");
  const [errorEcho, setErrorEcho] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef("");
  const targetRef = useRef<DraftTarget | null>(null);
  const pendingInputRef = useRef<PendingInput | null>(null);
  const pendingInputTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingInput = useCallback(() => {
    if (pendingInputTimer.current !== null) clearTimeout(pendingInputTimer.current);
    pendingInputTimer.current = null;
    pendingInputRef.current = null;
  }, []);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const beforeInput = (event: InputEvent) => {
      clearPendingInput();
      const pending = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        previous: valueRef.current,
        inputType: event.inputType,
      };
      pendingInputRef.current = pending;
      // beforeinput and its matching input share a browser task. A cancelled pre-edit event
      // cannot lend its range to a later task with indistinguishable repeated text.
      pendingInputTimer.current = setTimeout(() => {
        if (pendingInputRef.current === pending) pendingInputRef.current = null;
        pendingInputTimer.current = null;
      }, 0);
    };
    textarea.addEventListener("beforeinput", beforeInput);
    return () => {
      textarea.removeEventListener("beforeinput", beforeInput);
      clearPendingInput();
    };
  }, [clearPendingInput]);
  const setDraft = useCallback((next: string) => {
    clearPendingInput();
    if (next !== valueRef.current) targetRef.current = null;
    valueRef.current = next;
    setValue(next);
  }, [clearPendingInput]);
  const handleInput = useCallback((next: string, inputType: string | undefined): boolean => {
    const range = verifiedInputRange(valueRef.current, next, pendingInputRef.current, inputType);
    clearPendingInput();
    const hadTarget = targetRef.current !== null;
    if (hadTarget) {
      if (range) targetRef.current = mapTarget(targetRef.current!, range.start, range.oldEnd, range.newEnd);
      else {
        targetRef.current = null;
        setPartial("");
        setErrorEcho(null);
      }
    }
    valueRef.current = next;
    setValue(next);
    return !hadTarget || range !== null;
  }, [clearPendingInput]);
  const captureTarget = useCallback(() => {
    clearPendingInput();
    setErrorEcho(null);
    const textarea = textareaRef.current;
    targetRef.current = textarea
      ? { start: textarea.selectionStart, end: textarea.selectionEnd }
      : null;
  }, [clearPendingInput]);
  const onDictationEvent = useCallback((event: VoiceDictationEvent) => {
    if (event.kind === "recording") setErrorEcho(null);
    if (event.kind === "partial") {
      setPartial(event.text);
      setErrorEcho(null);
    }
    else if (event.kind === "final") {
      setPartial("");
      setErrorEcho(null);
      const target = targetRef.current;
      targetRef.current = null;
      if (target) {
        const current = valueRef.current;
        setDraft(current.slice(0, target.start) + event.text + current.slice(target.end));
      }
    } else if (event.kind === "failed" || event.kind === "cancelled") {
      setPartial("");
      setErrorEcho(event.kind === "failed" ? voiceStatusEcho({ kind: "error", reason: event.reason })?.text ?? "Dictation failed" : null);
      targetRef.current = null;
    }
  }, [setDraft]);
  const clearPartial = useCallback(() => {
    clearPendingInput();
    setPartial("");
    setErrorEcho(null);
    targetRef.current = null;
  }, [clearPendingInput]);
  return { value, setDraft, handleInput, textareaRef, partial, errorEcho, captureTarget, onDictationEvent, clearPartial };
}

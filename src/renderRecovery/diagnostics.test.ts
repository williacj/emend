// ABOUTME: Pins the frontend half of TD-28's fixed diagnostic trust boundary.
// ABOUTME: IPC and console fallback never carry caller-selected error or invalid phase text.
import { describe, expect, it, vi } from "vitest";
import { reportRenderFailure } from "./diagnostics";

describe("render-failure diagnostics", () => {
  it("sends exactly the closed phase DTO", async () => {
    const callBackendMock = vi.fn().mockResolvedValue(undefined);
    await reportRenderFailure("initial", callBackendMock);
    expect(callBackendMock).toHaveBeenCalledWith("report_render_failure", {
      input: { phase: "initial" },
    });
  });

  it("uses fixed console fallback fields and never the rejected error", async () => {
    const callBackendMock = vi.fn().mockRejectedValue(new Error("ghp_abc123 AcquisitionPlan"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await reportRenderFailure("remount", callBackendMock);
    expect(error).toHaveBeenCalledWith('{"kind":"react-render-failure","phase":"remount"}');
    expect(error.mock.calls.flat().join(" ")).not.toContain("ghp_abc123");
    error.mockRestore();
  });

  it("does not echo a runtime-invalid phase into IPC or console", async () => {
    const callBackendMock = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await reportRenderFailure("ghp_abc123" as "initial", callBackendMock);
    expect(callBackendMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('{"kind":"react-render-failure"}');
    error.mockRestore();
  });
});

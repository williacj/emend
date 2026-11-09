// ABOUTME: Pins platform-specific Tauri chrome and permissions so web title controls replace one native row.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readJson(path: string) {
  return JSON.parse(readFileSync(join(process.cwd(), path), "utf8"));
}

describe("window chrome configuration", () => {
  it("uses one undecorated Windows window and one macOS overlay with native traffic lights", () => {
    const windows = readJson("src-tauri/tauri.windows.conf.json").app.windows;
    const macos = readJson("src-tauri/tauri.macos.conf.json").app.windows;
    expect(windows).toHaveLength(1);
    expect(macos).toHaveLength(1);
    expect(windows[0]).toMatchObject({ label: "main", decorations: false, shadow: true });
    expect(macos[0]).toMatchObject({
      label: "main",
      decorations: true,
      titleBarStyle: "Overlay",
      hiddenTitle: true,
    });
  });

  it("grants only the window commands needed by the title row", () => {
    const permissions = readJson("src-tauri/capabilities/default.json").permissions;
    for (const name of ["allow-close", "allow-minimize", "allow-toggle-maximize", "allow-start-dragging"]) {
      expect(permissions).toContain(`core:window:${name}`);
    }
  });
});

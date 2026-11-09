ABOUTME: Requests the missing visual state for a restored unsupported legacy tab with retained unsaved text.
ABOUTME: Hands CJ's D27 recovery ruling to the design project without editing generated docs/design files.

# D27 legacy unsupported-tab recovery visual refresh

**Ruling:** CJ, 2026-10-01; D27 / FR-ED-3 / FR-ED-9, J2 and J12. A legacy restored tab for an unsupported document path with retained `unsavedContent` becomes an editable untitled recovery document containing that exact buffer. Its label names the former project path. Cowrite refuses to open or write the unsupported path; Save As adopts the buffer at a supported document path. A clean unsupported tab still closes after a visible refusal. An omitted over-cap buffer is not reconstructed from its former path.

Refresh the `9a`–`9f` untitled recovery family for this second entry route, including Windows and macOS peers:

1. Show the former project path in the recovery tab's label, with the established neutral `UNTITLED` treatment for a preserved buffer. Distinguish the former path from a current backing file; no project-rail row is active for the untitled tab.
2. Show a truthful, visible explanation that the former file type cannot open as a Cowrite document, that the retained text is now editable in the untitled tab, and that Save As is the route to a supported project document. Use the design system's existing status/notice vocabulary; decide its exact placement in the refresh.
3. Keep the ordinary preserved-buffer editor, no-autosave statement, Save As affordance, guarded close, and same-surface adoption of `9c.1`/`9c.7`. Do not draw the amber over-cap loss indicator merely because the former file type is unsupported; draw it only when a separate persisted omission fact actually exists, and never claim omitted bytes were recovered. Do not suggest Save As writes to the unsupported former path.
4. Keep the clean unsupported-session refusal distinct: it has no recovery buffer and does not create an empty recovery document. A session whose content was omitted over the cap is not evidence of retained text; never draw missing bytes as recovered.

This is an appearance handoff. Eligibility and lifecycle bind in `docs/functional-spec.md` FR-ED-3/9 and `docs/ux-design.md` J2/J12. The generated mocks currently cover displaced-path recovery and omission, but not this unsupported-path restore origin or its visible explanation.

**Refresh (20) correction requested (CJ, 2026-10-01, #2555):** `9h.2` draws an omission-only unsupported tab closing. CJ ruled that its tab and omission marker remain after the visible refusal so the loss fact stays protected; no untitled recovery buffer is created. Update the `9h.2` frame and annotation to show that retained tab and the same one-line refusal status. The clean `9h.1` tab still closes.

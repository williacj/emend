ABOUTME: Requests the appearance of document and Workshop conversations for the owner's design project.
ABOUTME: A handoff brief for D4/D15 as amended and J2; generated `docs/design/` files stay untouched until their next refresh.

# Document and Workshop conversations visual refresh brief

**Decision:** the owner, 2026-10-15, with D34/D35's superseded session-model ruling replaced 2026-11-12 (williacj/emend#22). D4 and D15 as amended, FR-CONV-1..10, and J2 in `docs/ux-design.md` hold the behavior. Each document keeps its own conversation, and a project keeps named Workshop conversations. A run stays in the conversation it started in. Visible history travels with the project, and provider session IDs stay on the machine.

None of these surfaces is drawn today. `docs/design/` options `1b`, `6a`, `6b` and `6c` draw one project-wide conversation and a rail with no Workshop entry, and `specs/state.md` "Known gaps" lists none of the surfaces below. Draw each for Windows and macOS with the existing tokens unless the refresh finds a layout need.

1. **Conversation naming.** A Workshop conversation has a name the author sees in the Workshop list, at the top of the Workshop, and on the link a born document shows back to it (FR-CONV-2, FR-CONV-5). Migration creates one named **Previous project conversation** (FR-CONV-10). Draw how a name appears, how the author creates and renames one, and how a document's own conversation is labelled in the right timeline, where it carries the document's name rather than one of its own.
2. **The Workshop list.** The Workshop's list lets the author create, find, reopen and resume earlier Workshop conversations (FR-CONV-2). Draw the list, an empty project, a long list, and the selected conversation. Before Send, the author can see which conversation is selected and which conversation the run will belong to; draw that indicator at the composer.
3. **Menu placement.** The project rail carries a fixed **Workshop** entry above Documents, and an app-menu action reaches the same place while the rail is collapsed (FR-CONV-2). Draw the rail entry in `6a`–`6c`'s Documents/Skills rail, its selected state, and the app-menu item on both platforms. Selecting the Workshop brings it center stage and closes no document tab.
4. **Sent-context disclosure.** Three disclosures are new:
   - A Workshop turn sends no open tab's unsaved text (FR-CONV-4). J13's standing composer line therefore has no active document to speak about in the Workshop. Draw what the Workshop composer shows while tabs are open and some are dirty.
   - A preloaded handoff summary sits in a born document's composer with its source and full text, editable and removable before Send (FR-CONV-6). Draw the preloaded, edited and removed states, and the sent turn's record of the exact text and its source.
   - A seed on another computer can omit context, and Emend says so (FR-CONV-9). Draw that disclosure and the error when an accepted handoff cannot fit.
5. **The saved-here versus shared status.** The UI tells the author whether a conversation's history is saved only on this computer or has travelled with the project, and that another computer sees only what its copy of the project holds (FR-CONV-8). It says so in the author's terms; no Git word appears (UX Principle 4). Draw both states and where the author meets them.

Also undrawn, and needed with the five above:

- **Cross-conversation links.** A run started in one document's conversation that changes another document appears once, in its own conversation; the other document's conversation shows a link to the run and its changes (FR-CONV-3). A born document shows a link to its Workshop origin (FR-CONV-5).
- **Elsewhere attention.** A pending permission request or a finished background run in a conversation that is not selected stays discoverable (FR-CONV-3). J7's attention cue covers the current Timeline host; draw how it reaches a conversation that is not showing.
- **The divergence marker.** Where two devices continued a conversation from the same point, a quiet marker sits where they diverge, for example "Continued on another computer" (FR-CONV-8).
- **The migration notice and relink.** A one-time, dismissible notice on the first document open after migration, linking to **Previous project conversation** and offering a selective handoff (FR-CONV-10). A visible relink route for a conversation whose document moved while Emend was not running (FR-CONV-7). The explicit error and recovery route when migration, reading, combining or reseeding fails (FR-CONV-10).

Behavior and eligibility bind in `docs/functional-spec.md` FR-CONV-1..10 and `docs/ux-design.md` J2. This brief asks the design project only for their appearance.

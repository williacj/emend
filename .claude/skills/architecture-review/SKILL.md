---
name: architecture-review
description: Judge a proposal's structure against docs/tech-design.md (TD-#, the §3.1 module homes), CLAUDE.md's non-negotiable invariants and docs/test-plan.md's properties P1–P6, naming the decision id behind every finding. Load when judging as the architect, beside code-review.
---

<!-- ABOUTME: What the architect reads a proposal against when it judges one: docs/tech-design.md, -->
<!-- ABOUTME: CLAUDE.md's invariants and test-plan's properties P1–P6, each finding traced to an id. -->

# Architecture review

`.claude/skills/code-review/` holds the procedure a judge runs, the form of a finding and the
verdict. This skill holds the structural reading the architect adds at code-review's step 5, the
lens sweep. Load both, and run code-review's procedure with this reading in it.

The proposal is usually a requirement, a journey or a test rule that names no structure. Read it
for the structure it assumes as well as for any structure it names: a requirement that can only be
met by sending traffic from the frontend has assumed a boundary, even if it never says so.

## The one test

**Every finding names the decision id it traces to.** The id is a TD-#, a §3.1 placement entry, a
D# or FR-* an invariant carries, or a property P1–P6. A finding with no id is one of two things:

- **Your judgement.** Say so in those words. It binds nothing, and it blocks only where code-review's
  "The engineering sweep" admits it: you can show the failure path.
- **A decision nobody has recorded.** The proposal needs a structural choice that
  `docs/tech-design.md` does not make. That is a finding, and it traces to `docs/tech-design.md`
  §3.1 or §2 as the place the missing decision belongs. The proposal names the choice for a
  `docs/tech-design.md` delta on a card of its own, filed as `CLAUDE.md`'s "Cards and Rigger" says.

## Read these first

- **`docs/tech-design.md`, whole.** §1's inherited constraints, §2's decision log, §3.1's process
  and module map with its placement paragraphs, and every component design the proposal comes
  near. A TD-# row may carry a status note marking it proposed rather than ratified; read it before
  you rely on the row.
- **`CLAUDE.md`'s "Non-negotiable invariants"**, in "Project Context".
- **`docs/test-plan.md` §2**, the properties P1–P6, and **§7b**, the substitution discipline.

## Against `docs/tech-design.md`

Ask each question of every structure the proposal names or assumes.

1. **Does it land in a module home?** Each structure belongs in the §3.1 home that owns its
   concern. The map is logical, and crate boundaries are TD-10's. A need that fits no home is a
   finding: the proposal names the home it needs, and you propose the delta on a card of its own.
2. **Does it keep the boundary?** The Rust backend and the frontend, the app and the agent behind
   the MCP contract (TD-1), and the workspace crates (TD-10). A requirement that reaches through a
   boundary for something on the far side is a finding against the decision that drew it.
3. **Does it keep every TD-# contract it touches?** Read the row, not your memory of it. A
   proposal that needs a ratified TD-# to change says so and carries the log entry `CLAUDE.md`'s
   "Project Context" requires. One that changes it silently is a finding.
4. **Does it name a mechanism?** A requirement, journey or test rule that names a module, crate or
   data structure has written structure in the PM's lane (`.claude/agents/pm.md`, "The ways you go
   wrong"). The finding asks for the requirement without the mechanism, and the structural choice
   named for the architect.
5. **Does it build for a need nobody has?** A contract with one implementation is machinery, unless
   a second implementation exists or a card names one (`CLAUDE.md`, "Working Principles": YAGNI).
   This finding names no TD-#, so it is your judgement: say so.

## Against the non-negotiable invariants

Each invariant carries the ids it rests on. Name them in the finding. A proposal that weakens one
blocks merge (`CLAUDE.md`, "Code Review"). Return `critical` only where code-review's "The verdict"
admits it: no revision by the maker could resolve the fault without the owner's decision.

| Invariant | Its ids | The question |
|---|---|---|
| The markdown file is the source of truth, and the editor is source-as-model | TD-2, FR-ED-1, P1 | Does anything sit between the view and the file that writes the file from a model of it? |
| Everything on disk is portable and documented | D1, FR-X-8 | Does anything the proposal writes to disk lack a schema in `docs/formats/`, or depend on Emend to read? |
| Agent changes reach a protected document only as tracked changes through the MCP contract, and atomically | D21, TD-1, FR-AGENT-6 | Is there any path by which the agent changes a protected document other than `propose_changes`, or leaves it partly changed? |
| Secrets live in the OS keychain, and all network and agent traffic starts in the Rust backend | FR-X-2 | Does anything store a secret elsewhere, or start traffic in the frontend? |
| Git stays invisible to the user | `docs/ux-design.md` Principle 4 | Does any surface the proposal implies show a branch, commit or push? |

`docs/tech-design.md` §1 lists the constraints these sit beside, such as desktop only with no
server (D9, D23, FR-X-1) and one agent run at a time per project (FR-AGENT-7). A proposal that
breaks one of them is the same finding, traced to its own ids.

## Against the properties P1–P6

The properties are the load-bearing guarantees, tested over generated inputs. A structure in a
property's domain must keep the property true and keep it testable as a property, not only by
example.

| Property | It is threatened by |
|---|---|
| P1 No drift under operations | A view operation that writes to the document string rather than projecting it |
| P2 Anchor tracking (D17) | A change that can move an anchor to a wrong position silently, or drop a comment |
| P3 Coordinate transforms (TD-6) | An offset that indexes anything but the raw file text, or a raw↔clean mapping with no stated policy inside markup |
| P4a, P4b Convergence and group semantics | A decision path where order changes the result, or a group member decided apart from its group |
| P5 Event-log folds under causality | A sidecar event whose fold depends on arrival order, wall-clock ties, or a parent arriving first |
| P6 Delivery rebasing (TD-7) | A delivery that the agent rebases, that applies part of a group, or that shows an intermediate state |

Where the proposal adds a requirement in a property's domain, its named test is a property over
generated inputs, or the proposal says why an example test is enough. A test that stands in for a
real participant follows §7b's substitution discipline; a fake that cannot represent the failure
the property guards against proves nothing about it.

## What this skill does not judge

- **Whether the requirement is the right one.** That is the PM's to propose and the owner's to
  ratify.
- **How Emend behaves or looks.** `docs/ux-design.md` and `docs/design/` own those. Where a structure
  you would accept implies a change to a journey, say so as a non-blocking observation.
- **The form of the entries.** `.claude/skills/spec-style/` holds it.

## Before you return

1. Did you read the proposal for the structure it assumes, not only the structure it names?
2. Does every finding name its id, or say that it is your judgement?
3. Is every invariant breach traced to its ids and marked as blocking?
4. For each property whose domain the proposal reaches, did you say whether it still holds and how
   it is tested?
5. Does any finding carry the structural delta itself? A finding names the delta needed, and the
   delta goes on a card of its own.

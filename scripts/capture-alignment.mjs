// ABOUTME: npm entry for the design-alignment capture: `npm run capture:alignment -- [scenario] [output folder]`.
// ABOUTME: Applies the arguments in place of EMEND_ALIGNMENT_SCENARIO and EMEND_ALIGNMENT_OUTPUT, then runs the harness.
import { alignmentEnvironment } from "./capture-design-alignment-state.mjs";

Object.assign(process.env, alignmentEnvironment(process.argv.slice(2), process.env));
await import("./capture-design-alignment.mjs");

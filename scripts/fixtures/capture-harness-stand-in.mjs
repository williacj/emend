// ABOUTME: Test-only loader that replaces the capture harness with a stand-in reporting the scenario and output it received.
// ABOUTME: Lets the npm entry be exercised without starting servers or a browser; loaded through NODE_OPTIONS --import.
import { register } from "node:module";

const hooks = `
  export async function resolve(specifier, context, next) {
    if (specifier.endsWith("capture-design-alignment.mjs")) {
      const report = "console.log('RECEIVED ' + JSON.stringify({ scenario: process.env.EMEND_ALIGNMENT_SCENARIO ?? null, output: process.env.EMEND_ALIGNMENT_OUTPUT ?? null }));";
      return { url: "data:text/javascript," + encodeURIComponent(report), shortCircuit: true };
    }
    return next(specifier, context);
  }
`;

register("data:text/javascript," + encodeURIComponent(hooks));

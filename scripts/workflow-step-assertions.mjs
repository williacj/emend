// ABOUTME: Step-block matching for this repo's regex-based GitHub Actions workflow tests.
// ABOUTME: `namedStep` returns one named step's YAML block, ending at the next step.

// Escapes a literal string for embedding inside a `new RegExp(...)` pattern. Step names in these
// workflows can carry regex-meaningful characters (e.g. the parenthesized "(test-plan §9b)" suffix on
// "Validate vitest unhandled-errors invariant") that would otherwise silently change what the
// constructed pattern matches rather than fail loudly.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function namedStep(yaml, name) {
  return yaml.match(new RegExp(`- name: ${escapeRegExp(name)}\\n([\\s\\S]*?)(?=\\n\\s+- name:|$)`));
}

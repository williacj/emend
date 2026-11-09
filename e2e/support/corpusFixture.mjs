// ABOUTME: Copies representative checked-in corpus documents into throwaway D23 e2e projects.
// ABOUTME: Preserves the source bytes so browser authoring tests never mutate repository fixtures.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureProject } from "./fixtureProject.mjs";

const corpusRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/corpus",
);

const corpusFixtures = {
  collectedDiscourses: "prose/collected-discourses.md",
  apiReference: "technical/api-reference.md",
  rustDataTypes: "technical/rust-book-data-types.md",
};

function readCorpusFixture(name) {
  const relativePath = corpusFixtures[name];
  if (!relativePath) throw new Error(`Unknown corpus fixture: ${name}`);
  return {
    bytes: readFileSync(path.join(corpusRoot, relativePath)),
    target: path.basename(relativePath),
  };
}

/**
 * @param {keyof typeof corpusFixtures} primaryName
 * @param {(keyof typeof corpusFixtures)[]} additionalNames
 */
export function createCorpusFixtureProject(primaryName, additionalNames = []) {
  const primary = readCorpusFixture(primaryName);
  const project = createFixtureProject(primary.bytes);
  const fixtures = new Map([[primaryName, { bytes: primary.bytes, path: project.path }]]);

  for (const name of additionalNames) {
    const fixture = readCorpusFixture(name);
    project.addFile(fixture.target, fixture.bytes);
    fixtures.set(name, { bytes: fixture.bytes, path: fixture.target });
  }

  function copiedFixture(name) {
    const fixture = fixtures.get(name);
    if (!fixture) throw new Error(`Corpus fixture was not copied into this project: ${name}`);
    return fixture;
  }

  return {
    ...project,
    fixturePath(name) {
      return copiedFixture(name).path;
    },
    originalBytes(name) {
      return Buffer.from(copiedFixture(name).bytes);
    },
    originalText(name) {
      return copiedFixture(name).bytes.toString("utf8");
    },
  };
}

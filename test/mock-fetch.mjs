// Preloaded by the golden test (node --import): answers fetch() for recorded feed URLs from
// test/golden/feeds/ and refuses everything else, so a run is offline and repeatable. The
// Hugging Face company tagger can't download its model either, so both engines skip it.
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FIXTURE_DIR;
const index = JSON.parse(readFileSync(path.join(dir, "index.json"), "utf8"));
globalThis.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  const file = index[url];
  if (!file) throw new Error(`offline test: no fixture for ${url}`);
  return new Response(readFileSync(path.join(dir, file)), { status: 200, headers: { "content-type": "application/xml" } });
};

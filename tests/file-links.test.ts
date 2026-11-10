import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveFileLinks } from "../src/file-links.ts";

const cwd = "/tmp/example project";

for (const [source, expected] of [
  ["[video](render/final.mp4)", "[video](file:///tmp/example%20project/render/final.mp4)"],
  ["[file](</tmp/my file.txt>)", "[file](<file:///tmp/my%20file.txt>)"],
  ["[file](my%20file.txt \"a title\")", "[file](file:///tmp/example%20project/my%20file.txt \"a title\")"],
  ["[file](my\\ file.txt)", "[file](file:///tmp/example%20project/my%20file.txt)"],
  ["[file](dir/a(b).txt)", "[file](file:///tmp/example%20project/dir/a%28b%29.txt)"],
  ["[file][ref]\n\n[ref]: docs/readme.md", "[file][ref]\n\n[ref]: file:///tmp/example%20project/docs/readme.md"],
  ["[web](https://example.com/a)", "[web](https://example.com/a)"],
  ["[absolute](file:///tmp/a.mp4)", "[absolute](file:///tmp/a.mp4)"],
  ["[mail](mailto:a@example.com)", "[mail](mailto:a@example.com)"],
  ["[section](#heading)", "[section](#heading)"],
  ["[file](readme.md#setup)", "[file](file:///tmp/example%20project/readme.md#setup)"],
  ["[file](log.txt?line=8)", "[file](file:///tmp/example%20project/log.txt?line=8)"],
  ["[note] text ](guide.md)", "[note] text ](guide.md)"],
  ["![image](pic.png)", "![image](pic.png)"],
  ["`[link](private.txt)`", "`[link](private.txt)`"],
  ["```md\n[link](private.txt)\n```", "```md\n[link](private.txt)\n```"],
  ["~~~md\n[link](private.txt)\n~~~", "~~~md\n[link](private.txt)\n~~~"],
  ["    [link](private.txt)", "    [link](private.txt)"],
  ["[link](incomplete", "[link](incomplete"],
  ["[link](bad%00name)", "[link](bad%00name)"],
  ["[link](bad%xxname)", "[link](bad%xxname)"]
]) {
  test(`resolves file link safely: ${JSON.stringify(source)}`, () => {
    const result = resolveFileLinks(source, cwd);
    assert.equal(result, expected);
    assert.equal(resolveFileLinks(result, cwd), result);
  });
}

test("does not guess when session cwd is unavailable", () => {
  assert.equal(resolveFileLinks("[x](file.txt)", ""), "[x](file.txt)");
});

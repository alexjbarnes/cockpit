import { describe, expect, it } from "vitest";
import { detectLanguage, extensionForLabel, extractTextFiles } from "@/lib/paste-detect";

describe("extractTextFiles", () => {
  it("extracts a single file block and returns cleaned text", () => {
    const result = extractTextFiles('<file path="paste.ts">\nconst x = 1\n</file>\n\nreview this');
    expect(result.cleaned).toBe("review this");
    expect(result.textFiles).toEqual([{ name: "paste.ts", content: "const x = 1" }]);
  });

  it("returns input as cleaned when no file block is present", () => {
    const result = extractTextFiles("  just some text  ");
    expect(result.cleaned).toBe("just some text");
    expect(result.textFiles).toEqual([]);
  });

  it("handles a file block with no trailing text", () => {
    const result = extractTextFiles('<file path="data.txt">\nhello world\n</file>');
    expect(result.cleaned).toBe("");
    expect(result.textFiles).toEqual([{ name: "data.txt", content: "hello world" }]);
  });

  it("extracts two file blocks in order", () => {
    const result = extractTextFiles('<file path="a.ts">\ncontent a\n</file>\n\n<file path="b.ts">\ncontent b\n</file>\n\nsummary');
    expect(result.cleaned).toBe("summary");
    expect(result.textFiles).toEqual([
      { name: "a.ts", content: "content a" },
      { name: "b.ts", content: "content b" },
    ]);
  });
});

// Detection swapped off magika (see paste-detect.ts for the measurements and
// why). These pin the parts that are decisions rather than a statistical guess:
// the signatures checked ahead of highlight.js, the contract the caller relies
// on (a label that maps to an extension, or null), and the curated subset.
describe("detectLanguage", () => {
  it("recognises JSON by parsing it, which highlight.js alone reads as Swift", async () => {
    const json = JSON.stringify({ name: "cockpit", nested: { list: [1, 2, 3], flag: true } }, null, 2);
    expect(await detectLanguage(json)).toBe("json");
    expect(extensionForLabel((await detectLanguage(json)) as string)).toBe("json");
  });

  it("does not claim JSON for a fragment that cannot parse", async () => {
    // A pasted middle-of-a-file fragment. Anything but "json" is acceptable;
    // claiming valid JSON would be a lie about the content.
    expect(await detectLanguage('{ "a": 1,\n  "b": [2, 3')).not.toBe("json");
  });

  it("reads a shebang as the interpreter it names", async () => {
    expect(await detectLanguage("#!/bin/bash\nset -euo pipefail\necho hi\n")).toBe("shell");
    expect(await detectLanguage("#!/usr/bin/env python3\nprint('hi')\n")).toBe("python");
    expect(await detectLanguage("#!/usr/bin/env node\nconsole.log('hi')\n")).toBe("javascript");
  });

  it("recognises an HTML document and a PHP open tag outright", async () => {
    expect(await detectLanguage("<!doctype html>\n<html>\n<body>hi</body>\n</html>")).toBe("html");
    expect(await detectLanguage("<?php\n$x = 1;\necho $x;\n")).toBe("php");
  });

  it("labels ordinary source it is confident about", async () => {
    const python = `import os\nfrom pathlib import Path\n\n\ndef load(config_path: str) -> dict:\n    with open(config_path) as handle:\n        return json.load(handle)\n\n\nif __name__ == "__main__":\n    print(load(os.environ["CONFIG"]))\n`;
    expect(await detectLanguage(python)).toBe("python");
  });

  it("known weakness: identifiers that read as SQL can win over the real language", async () => {
    // Not a wish, a record of measured behaviour: this Python is labelled sql,
    // because highlight.js scores "rows", "total" and "result" as SQL. Kept so
    // the day it changes is visible rather than silent.
    const sqlish = `def total(rows):\n    result = 0\n    for row in rows:\n        result += row.amount\n    return result\n`;
    expect(await detectLanguage(sqlish)).toBe("sql");
  });

  it("returns null rather than guess at text with no signal", async () => {
    expect(await detectLanguage("the quick brown fox\njumped over\nthe lazy dog\n")).toBeNull();
    expect(await detectLanguage("")).toBeNull();
  });

  it("only ever returns a label the caller can turn into an extension", async () => {
    // The caller renames the paste chip with extensionForLabel(label); a label
    // outside that map would leave the chip unnamed.
    const samples = [
      '{"a":1}',
      "#!/bin/sh\necho hi",
      "<?php echo 1;",
      "SELECT id, name FROM users WHERE active = true ORDER BY name;",
      'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n',
      "interface A { name: string }\nconst a: A = { name: 'x' };\nexport default a;\n",
    ];
    for (const sample of samples) {
      const label = await detectLanguage(sample);
      if (label !== null) expect(extensionForLabel(label), `label ${label} has no extension`).toBeTruthy();
    }
  });

  it("leaves the languages dropped from the subset unlabelled rather than mislabelled", async () => {
    // Lua is not offered to the guess: it used to win against Go. Whatever comes
    // back, it must not be a confident wrong answer dressed as Lua.
    const lua = "local function add(a, b)\n  return a + b\nend\n\nlocal t = {}\nfor i = 1, 10 do\n  t[i] = add(i, i)\nend\n";
    expect(await detectLanguage(lua)).not.toBe("lua");
  });
});

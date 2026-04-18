import { describe, expect, it } from "vitest";
import { highlightCode, languageFromPath, stripLineNumbers } from "@/lib/code-highlight";

describe("languageFromPath", () => {
  it("maps common extensions to shiki language IDs", () => {
    expect(languageFromPath("/home/user/main.go")).toBe("go");
    expect(languageFromPath("/src/index.ts")).toBe("typescript");
    expect(languageFromPath("/src/app.tsx")).toBe("tsx");
    expect(languageFromPath("script.py")).toBe("python");
    expect(languageFromPath("styles.css")).toBe("css");
    expect(languageFromPath("query.sql")).toBe("sql");
    expect(languageFromPath("config.yaml")).toBe("yaml");
    expect(languageFromPath("config.yml")).toBe("yaml");
    expect(languageFromPath("data.json")).toBe("json");
    expect(languageFromPath("main.rs")).toBe("rust");
    expect(languageFromPath("main.c")).toBe("c");
    expect(languageFromPath("main.cpp")).toBe("cpp");
    expect(languageFromPath("App.jsx")).toBe("jsx");
    expect(languageFromPath("deploy.sh")).toBe("bash");
    expect(languageFromPath("page.html")).toBe("html");
    expect(languageFromPath("main.java")).toBe("java");
    expect(languageFromPath("lib.rb")).toBe("ruby");
  });

  it("handles case-insensitive extensions", () => {
    expect(languageFromPath("FILE.GO")).toBe("go");
    expect(languageFromPath("INDEX.TS")).toBe("typescript");
    expect(languageFromPath("App.JSX")).toBe("jsx");
  });

  it("handles special filenames", () => {
    expect(languageFromPath("/app/Dockerfile")).toBe("dockerfile");
    expect(languageFromPath("/app/dockerfile")).toBe("dockerfile");
    expect(languageFromPath("Makefile")).toBe("makefile");
  });

  it("returns undefined for unknown extensions", () => {
    expect(languageFromPath("file.xyz")).toBeUndefined();
    expect(languageFromPath("file.unknown")).toBeUndefined();
  });

  it("returns undefined for files without extensions", () => {
    expect(languageFromPath("README")).toBeUndefined();
    expect(languageFromPath("/bin/mycommand")).toBeUndefined();
  });

  it("extracts basename from full paths", () => {
    expect(languageFromPath("/home/user/projects/app/src/main.go")).toBe("go");
    expect(languageFromPath("../../relative/path/file.ts")).toBe("typescript");
  });
});

describe("stripLineNumbers", () => {
  it("strips cat -n style line number prefixes", () => {
    const input = '     1\u2192package main\n     2\u2192\n     3\u2192import "fmt"';
    const result = stripLineNumbers(input);
    expect(result.code).toBe('package main\n\nimport "fmt"');
    expect(result.startLine).toBe(1);
  });

  it("preserves starting line number for offset reads", () => {
    const input = "    10\u2192func foo() {\n    11\u2192    return 1\n    12\u2192}";
    const result = stripLineNumbers(input);
    expect(result.code).toBe("func foo() {\n    return 1\n}");
    expect(result.startLine).toBe(10);
  });

  it("returns raw code when no line number prefixes found", () => {
    const input = 'func main() {\n    fmt.Println("hello")\n}';
    const result = stripLineNumbers(input);
    expect(result.code).toBe(input);
    expect(result.startLine).toBe(1);
  });

  it("handles single line with prefix", () => {
    const input = "     1\u2192hello world";
    const result = stripLineNumbers(input);
    expect(result.code).toBe("hello world");
    expect(result.startLine).toBe(1);
  });

  it("handles empty content after prefix", () => {
    const input = "     5\u2192";
    const result = stripLineNumbers(input);
    expect(result.code).toBe("");
    expect(result.startLine).toBe(5);
  });
});

describe("highlightCode", () => {
  it("produces colored HTML for Go code", async () => {
    const html = await highlightCode('func main() {\n\tfmt.Println("hello")\n}', "go", "github-dark");
    expect(html).not.toBeNull();
    expect(html).toContain("color:");
    expect(html).toContain("func");
    expect(html).toContain('<pre class="shiki');
  });

  it("produces colored HTML for TypeScript code", async () => {
    const html = await highlightCode('const x: number = 42;\nfunction hello(): string { return "hi"; }', "typescript", "github-dark");
    expect(html).not.toBeNull();
    expect(html).toContain("color:");
    expect(html).toContain("const");
  });

  it("supports github-light theme", async () => {
    const html = await highlightCode("let x = 1;", "javascript", "github-light");
    expect(html).not.toBeNull();
    expect(html).toContain("github-light");
    expect(html).toContain("color:");
  });

  it("supports Python", async () => {
    const html = await highlightCode("def hello():\n    print('hi')", "python", "github-dark");
    expect(html).not.toBeNull();
    expect(html).toContain("color:");
  });

  it("returns null for unsupported languages", async () => {
    const html = await highlightCode("some code", "not-a-real-language", "github-dark");
    expect(html).toBeNull();
  });

  it("produces different output for dark vs light themes", async () => {
    const code = "const x = 42;";
    const dark = await highlightCode(code, "javascript", "github-dark");
    const light = await highlightCode(code, "javascript", "github-light");
    expect(dark).not.toBeNull();
    expect(light).not.toBeNull();
    expect(dark).not.toBe(light);
  });
});

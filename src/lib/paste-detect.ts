import type { TextFileAttachment } from "@/types";

const FILE_TAG_RE = /<file\s+path="([^"]+)">\n([\s\S]*?)\n<\/file>/g;

export function extractTextFiles(text: string): { cleaned: string; textFiles: TextFileAttachment[] } {
  const textFiles: TextFileAttachment[] = [];
  const cleaned = text
    .replace(FILE_TAG_RE, (_match, name: string, content: string) => {
      textFiles.push({ name, content });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleaned, textFiles };
}

const MIN_LINES = 10;

// Map Magika content type labels to file extensions for naming and syntax highlighting.
const LABEL_TO_EXT: Record<string, string> = {
  asm: "asm",
  awk: "awk",
  batch: "bat",
  c: "c",
  clojure: "clj",
  cmake: "cmake",
  cobol: "cob",
  coffeescript: "coffee",
  cpp: "cpp",
  cs: "cs",
  css: "css",
  csv: "csv",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  elixir: "ex",
  erlang: "erl",
  fortran: "f90",
  gleam: "gleam",
  go: "go",
  gradle: "gradle",
  groovy: "groovy",
  h: "h",
  handlebars: "hbs",
  haskell: "hs",
  hcl: "tf",
  hpp: "hpp",
  html: "html",
  ini: "ini",
  java: "java",
  javascript: "js",
  json: "json",
  jsonc: "jsonc",
  jsonl: "jsonl",
  jsx: "jsx",
  julia: "jl",
  kotlin: "kt",
  latex: "tex",
  less: "less",
  lisp: "lisp",
  lua: "lua",
  makefile: "makefile",
  markdown: "md",
  matlab: "m",
  nim: "nim",
  objectivec: "m",
  ocaml: "ml",
  odin: "odin",
  pascal: "pas",
  perl: "pl",
  php: "php",
  powershell: "ps1",
  prolog: "pl",
  proto: "proto",
  python: "py",
  r: "r",
  rst: "rst",
  ruby: "rb",
  rust: "rs",
  scala: "scala",
  scheme: "scm",
  scss: "scss",
  shell: "sh",
  solidity: "sol",
  sql: "sql",
  svelte: "svelte",
  svg: "svg",
  swift: "swift",
  tcl: "tcl",
  toml: "toml",
  tsx: "tsx",
  typescript: "ts",
  vba: "vba",
  verilog: "v",
  vhdl: "vhdl",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yara: "yar",
  zig: "zig",
};

export function shouldCollapsePaste(content: string): boolean {
  return content.split(/\r?\n/).length >= MIN_LINES;
}

export function extensionForLabel(label: string): string | undefined {
  return LABEL_TO_EXT[label];
}

/**
 * Detection runs on highlight.js, whose grammars the page already loads through
 * `rehype-highlight` for rendering code blocks, so this shares them rather than
 * adding anything to what a user downloads.
 *
 * This replaced Google's magika, measured over 179 real source files in 15
 * languages, in both shapes that arrive here — a whole file, and a 30-line
 * window standing in for a fragment:
 *
 *                      whole file        30-line paste
 *   magika             96% right         79% right
 *   here               86% right         83% right
 *
 * Magika reads a whole file better and, more usefully, declines rather than
 * guesses: it was wrong on 1% of files against 14% here. It was still not worth
 * its price. Magika pulls `@tensorflow/tfjs-node` as an optional dependency,
 * which every user installing cockpit paid for at 659MB and six advisories
 * including one critical. An npm `overrides` entry fixed that for this repo's
 * own install and does nothing for anyone installing the published package,
 * because overrides do not apply to a package installed as a dependency.
 *
 * What is lost is accuracy on a label; what a wrong label costs is the extension
 * on a collapsed paste chip and the highlighter it picks. The paste itself is
 * untouched either way.
 */

/**
 * The languages worth guessing between, which is not the same as the languages
 * worth highlighting.
 *
 * PHP, Swift, Kotlin, Lua and Perl are deliberately absent. Each is rare in a
 * paste here and each won often against something common — PHP took TypeScript
 * eight times, Lua took Go five times — so dropping the five lifted a realistic
 * paste from 72% to 83%. A file in one of them now goes unlabelled instead of
 * mislabelled, and highlighting still handles all of them when rendering; this
 * list only decides what the guess may return. `<?php` is still recognised
 * outright below, where it is decisive rather than statistical.
 */
const DETECT_SUBSET = [
  "python",
  "go",
  "rust",
  "java",
  "bash",
  "yaml",
  "ini",
  "sql",
  "css",
  "xml",
  "markdown",
  "json",
  "typescript",
  "javascript",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "diff",
];

/** highlight.js names to the labels above. `ini` covers TOML, which is what
 *  gets pasted; `xml` covers HTML. */
const HLJS_TO_LABEL: Record<string, string> = {
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
  bash: "shell",
  yaml: "yaml",
  ini: "toml",
  sql: "sql",
  css: "css",
  xml: "html",
  markdown: "markdown",
  json: "json",
  typescript: "typescript",
  javascript: "javascript",
  c: "c",
  cpp: "cpp",
  csharp: "cs",
  ruby: "ruby",
  php: "php",
  swift: "swift",
  kotlin: "kotlin",
  lua: "lua",
  perl: "perl",
  diff: "diff",
};

/**
 * Below this, highlight.js is guessing. Raising it only trades a correct answer
 * for no answer at roughly one for one (measured), so it sits where the guess
 * is still worth making.
 */
const MIN_RELEVANCE = 5;

/**
 * Signatures that identify a language outright, checked before the statistical
 * guess because each is decisive and highlight.js gets several of them wrong —
 * a JSON body it reads as Swift, a shell script as Perl.
 *
 * Deliberately no markdown rule: every cheap signal for it (a heading, a fence,
 * a link) also reads as a comment or a string in YAML, Python, TOML and shell,
 * and claiming markdown on those lost more than it won.
 */
function decisiveLabel(sample: string): string | null {
  const trimmed = sample.trim();

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // A pasted fragment of JSON will not parse. Let the guess have it.
    }
  }

  const shebang = trimmed.match(/^#!.*\b(bash|zsh|sh|python\d?|node|ruby|perl)\b/);
  if (shebang) {
    const bin = shebang[1];
    if (bin.startsWith("python")) return "python";
    if (bin === "node") return "javascript";
    if (bin === "ruby") return "ruby";
    if (bin === "perl") return "perl";
    return "shell";
  }

  if (/^\s*<!doctype html|^\s*<html\b/i.test(trimmed)) return "html";
  if (trimmed.startsWith("<?php")) return "php";

  return null;
}

type Hljs = { highlightAuto(code: string, subset?: string[]): { language?: string; relevance: number } };
let hljsPromise: Promise<Hljs> | null = null;

/**
 * highlight.js's own auto-detect, NOT lowlight's.
 *
 * lowlight re-implements the loop and keeps a grammar's score even when the
 * text hits something that grammar forbids, so `ini` — which scores on any
 * `key = value` line — won on Java, TypeScript and JavaScript alike and dragged
 * accuracy down by 17 points. The grammars themselves are the same modules
 * `rehype-highlight` already loads through lowlight, so this shares them rather
 * than adding a second copy.
 */
export async function detectLanguage(text: string): Promise<string | null> {
  const sample = text.slice(0, 8192);
  try {
    const decisive = decisiveLabel(sample);
    if (decisive) return decisive;

    if (!hljsPromise) {
      hljsPromise = import("highlight.js/lib/common").then((m) => m.default as Hljs);
    }
    const hljs = await hljsPromise;
    const result = hljs.highlightAuto(sample, DETECT_SUBSET);
    if (!result.language || result.relevance < MIN_RELEVANCE) return null;

    const label = HLJS_TO_LABEL[result.language];
    return label && LABEL_TO_EXT[label] ? label : null;
  } catch {
    return null;
  }
}

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

// Lazy-loaded client-side Magika instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let magikaPromise: Promise<any> | null = null;

export async function detectLanguage(text: string): Promise<string | null> {
  try {
    if (!magikaPromise) {
      magikaPromise = import("magika").then((m) => m.Magika.create());
    }
    const magika = await magikaPromise;
    const bytes = new TextEncoder().encode(text.slice(0, 8192));
    const result = await magika.identifyBytes(bytes);
    const label = result.prediction.output.label;
    if (label === "txt" || label === "unknown" || label === "empty") return null;
    return LABEL_TO_EXT[label] ? label : null;
  } catch {
    return null;
  }
}

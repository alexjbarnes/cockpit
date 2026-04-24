import { pathBasename } from "@/lib/path";

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  md: "markdown",
  mdx: "mdx",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  tf: "hcl",
  lua: "lua",
  r: "r",
  php: "php",
  scala: "scala",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  hs: "haskell",
  ml: "ocaml",
  zig: "zig",
};

export function languageFromPath(filePath: string): string | undefined {
  const basename = pathBasename(filePath) || "";

  const lower = basename.toLowerCase();
  if (lower === "dockerfile") return "dockerfile";
  if (lower === "makefile") return "makefile";

  const ext = basename.includes(".") ? basename.split(".").pop()?.toLowerCase() : undefined;
  if (!ext) return undefined;
  return EXT_TO_LANG[ext];
}

// Strip `cat -n` style line number prefixes (e.g. "     1\u2192content")
export function stripLineNumbers(raw: string): { code: string; startLine: number } {
  const lines = raw.split(/\r?\n/);
  const lineNumPattern = /^\s*(\d+)\u2192(.*)$/;
  const first = lines[0]?.match(lineNumPattern);
  if (!first) return { code: raw, startLine: 1 };

  const startLine = parseInt(first[1], 10);
  const stripped = lines.map((line) => {
    const m = line.match(lineNumPattern);
    return m ? m[2] : line;
  });
  return { code: stripped.join("\n"), startLine };
}

export async function highlightCode(code: string, language: string, theme: "github-dark" | "github-light"): Promise<string | null> {
  try {
    const shiki = await import("shiki/bundle/full");
    return await shiki.codeToHtml(code, { lang: language, theme });
  } catch {
    return null;
  }
}

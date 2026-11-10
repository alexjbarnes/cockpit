import type { ThemedToken } from "@pierre/highlights";
import { pathBasename } from "@/lib/path";

export type HighlightTheme = "pierre-dark" | "pierre-light";

/** Language names our extension map uses that Pierre spells differently. */
export const LANGUAGE_ALIASES: Record<string, string> = {};

export function aliasedLanguage(language: string): string {
  return LANGUAGE_ALIASES[language] ?? language;
}

export const EXT_TO_LANG: Record<string, string> = {
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function tokenHtml(token: ThemedToken): string {
  const styles: string[] = [];
  if (token.color) styles.push(`color:${token.color}`);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & 1) styles.push("font-style:italic");
  if (fontStyle & 2) styles.push("font-weight:700");
  if (fontStyle & 4) styles.push("text-decoration:underline");
  if (fontStyle & 8) styles.push("text-decoration:line-through");
  const attr = styles.length > 0 ? ` style="${styles.join(";")}"` : "";
  return `<span${attr}>${escapeHtml(token.content)}</span>`;
}

/** Turn Pierre's per-line tokens into the HTML the code block styles expect:
 *  one `.line` span per line, which keeps the counter-based line numbers and
 *  the wrap CSS working. */
export function tokensToHtml(tokens: readonly (readonly ThemedToken[])[], fg: string, theme: HighlightTheme): string {
  const lines = tokens.map((line) => `<span class="line">${line.map(tokenHtml).join("")}</span>`).join("\n");
  const color = fg ? ` style="color:${fg}"` : "";
  return `<pre class="highlights" data-theme="${theme}"${color}><code>${lines}</code></pre>`;
}

export async function highlightCode(code: string, language: string, theme: HighlightTheme): Promise<string | null> {
  try {
    const [highlights, themeModule] = await Promise.all([
      import("@pierre/highlights"),
      theme === "pierre-dark" ? import("@pierre/highlights/themes/pierre-dark") : import("@pierre/highlights/themes/pierre-light"),
    ]);
    const lang = aliasedLanguage(language);
    if (!highlights.isSupportedLanguage(lang)) return null;
    const result = highlights.codeToTokens(code, { lang, theme: themeModule.default });
    return tokensToHtml(result.tokens, result.fg ?? "", theme);
  } catch {
    return null;
  }
}

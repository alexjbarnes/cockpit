const MIN_LINES_FOR_COLLAPSE = 30;

export function detectPasteLanguage(content: string): string | null {
  const trimmed = content.trim();

  // JSON: starts with { or [ and parses successfully
  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not valid JSON, continue
    }
  }

  // XML/HTML: starts with < and has closing tags
  if (/^<[a-zA-Z!?]/.test(trimmed) && /<\/[a-zA-Z]/.test(trimmed)) {
    return /<html|<head|<body|<div|<span|<p\b|<!DOCTYPE/i.test(trimmed) ? "html" : "xml";
  }

  // YAML: multiple lines of key: value (not just one)
  const yamlLines = trimmed.split("\n").filter((l) => /^\s*[\w.-]+\s*:/.test(l));
  if (yamlLines.length >= 3) return "yaml";

  // Shell script patterns
  if (/^#!\s*\//.test(trimmed) || /^\$\s/.test(trimmed)) return "sh";

  // SQL: require at least 2 distinct SQL keywords
  const sqlKeywords = trimmed.match(/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE|INTO|VALUES|SET|TABLE|INDEX|JOIN|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT)\b/gi);
  const uniqueSql = new Set((sqlKeywords || []).map((k) => k.toUpperCase().replace(/\s+/, " ")));
  if (uniqueSql.size >= 2) return "sql";

  // Go
  if (/^package\s+\w+/m.test(trimmed) || /\bfunc\s+\w+\s*\(/.test(trimmed)) return "go";

  // Python
  if (/^(from\s+\S+\s+import|import\s+\S+|def\s+\w+\s*\(|class\s+\w+.*:)/m.test(trimmed)) return "py";

  // TypeScript/JavaScript
  if (/^(import\s+.*from\s|export\s+(default\s+)?|const\s+\w+|function\s+\w+|interface\s+\w+|type\s+\w+\s*=)/m.test(trimmed)) return "ts";

  // Rust
  if (/^(use\s+\w|fn\s+\w|pub\s+(fn|struct|enum|mod)\s|impl\s)/m.test(trimmed)) return "rs";

  // Java/Kotlin
  if (/^(public\s+class|private\s+class|protected\s+class|class\s+\w+\s*\{)/m.test(trimmed)) return "java";

  // CSS
  if (/^\s*[.#@][\w-]+\s*\{/m.test(trimmed) && /[{};]/.test(trimmed)) return "css";

  // Log patterns: lines with timestamps or log levels
  const logLines = trimmed.split("\n").filter((l) =>
    /^\d{4}[-/]\d{2}[-/]\d{2}/.test(l) || /^\[?(INFO|WARN|ERROR|DEBUG|TRACE)\]?\s/i.test(l)
  );
  if (logLines.length >= 3) return "log";

  return null;
}

export function shouldCollapsePaste(content: string): boolean {
  const lang = detectPasteLanguage(content);
  if (lang) return true;
  const lineCount = content.split("\n").length;
  return lineCount >= MIN_LINES_FOR_COLLAPSE;
}

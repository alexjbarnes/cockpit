import { HighlightStyle, syntaxHighlighting, type TagStyle } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type Tag, tags } from "@lezer/highlight";
import type { Theme, ThemeSyntaxSettings } from "@pierre/highlights";
import pierreDark from "@pierre/highlights/themes/pierre-dark";
import pierreLight from "@pierre/highlights/themes/pierre-light";

type SyntaxValue = string | ThemeSyntaxSettings | undefined;

function syntaxStyle(theme: Theme, keys: readonly string[]): ThemeSyntaxSettings | null {
  const syntax = theme.style.syntax ?? {};
  for (const key of keys) {
    const value = syntax[key] as SyntaxValue;
    if (!value) continue;
    if (typeof value === "string") return { color: value };
    return value;
  }
  return null;
}

/** The theme's Tree-sitter-style syntax names, mapped onto the tags
 *  CodeMirror's JavaScript mode emits. */
const TAG_KEYS: ReadonlyArray<readonly [Tag | readonly Tag[], readonly string[]]> = [
  [
    [tags.comment, tags.lineComment, tags.blockComment],
    ["comment", "comment.doc"],
  ],
  [tags.string, ["string", "string.template", "template_string"]],
  [tags.special(tags.string), ["string.special", "string.special.symbol"]],
  [tags.regexp, ["string.regex"]],
  [tags.escape, ["string.escape"]],
  [tags.number, ["number", "number.unit"]],
  [tags.bool, ["boolean"]],
  [tags.atom, ["constant", "value", "constant.css"]],
  [tags.keyword, ["keyword"]],
  [tags.controlKeyword, ["keyword"]],
  [tags.moduleKeyword, ["keyword"]],
  [tags.definitionKeyword, ["keyword"]],
  [tags.operator, ["operator", "keyword.operator"]],
  [tags.operatorKeyword, ["keyword.operator", "operator"]],
  [tags.function(tags.variableName), ["function", "function.call"]],
  [tags.function(tags.propertyName), ["function.method", "method_definition"]],
  [tags.typeName, ["type", "type.builtin"]],
  [tags.className, ["class", "class_name", "type.class"]],
  [tags.variableName, ["variable", "variable.member"]],
  [tags.local(tags.variableName), ["variable"]],
  [tags.special(tags.variableName), ["variable.special", "variable.builtin"]],
  [tags.propertyName, ["property", "property_name", "property_identifier"]],
  [tags.attributeName, ["attribute", "property"]],
  [tags.tagName, ["tag_name", "tag", "tag.jsx", "tag.component"]],
  [tags.namespace, ["namespace"]],
  [tags.labelName, ["label"]],
  [tags.meta, ["comment", "preproc"]],
  [tags.processingInstruction, ["preproc", "keyword.directive"]],
  [tags.link, ["keyword.operator"]],
];

function highlightStyle(theme: Theme): HighlightStyle {
  const styles: TagStyle[] = [];
  for (const [tag, keys] of TAG_KEYS) {
    const syntax = syntaxStyle(theme, keys);
    if (!syntax) continue;
    styles.push({
      tag,
      ...(syntax.color ? { color: syntax.color } : {}),
      ...(syntax.font_style === "italic" ? { fontStyle: "italic" } : {}),
      ...(syntax.font_weight ? { fontWeight: String(syntax.font_weight) } : {}),
    });
  }
  return HighlightStyle.define(styles);
}

function codeTheme(theme: Theme): Extension[] {
  const foreground = theme.style["editor.foreground"] ?? theme.style.text ?? "var(--color-foreground)";
  const player = theme.style.players?.[0];
  const cursor = player?.cursor ?? "var(--color-foreground)";
  const selection = player?.selection ?? "color-mix(in oklch, var(--chart-1) 30%, transparent)";

  return [
    syntaxHighlighting(highlightStyle(theme)),
    EditorView.theme({
      "&": {
        backgroundColor: "transparent",
        color: foreground,
        height: "100%",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
        fontSize: "12px",
        lineHeight: "1.6",
      },
      ".cm-content": {
        padding: "8px",
        caretColor: cursor,
      },
      ".cm-gutters": {
        backgroundColor: "transparent",
        borderRight: "none",
        color: "rgba(115, 138, 148, 0.4)",
      },
      ".cm-lineNumbers .cm-gutterElement": {
        padding: "0 1.5ch 0 0",
        minWidth: "3ch",
      },
      ".cm-activeLine": {
        backgroundColor: "transparent",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: cursor,
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
        backgroundColor: selection,
      },
      ".cm-selectionMatch": {
        backgroundColor: selection,
      },
      ".cm-panels": {
        backgroundColor: "var(--color-background)",
        color: "var(--color-foreground)",
      },
    }),
  ];
}

const DARK = codeTheme(pierreDark);
const LIGHT = codeTheme(pierreLight);

/** CodeMirror extensions for the Pierre palette, matching the read-only code
 *  blocks and the diff viewer. */
export function pierreCodeTheme(dark: boolean): Extension[] {
  return dark ? DARK : LIGHT;
}

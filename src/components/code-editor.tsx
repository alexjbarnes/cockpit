"use client";

import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { pierreCodeTheme } from "@/lib/pierre-codemirror";

/** Markdown's mark tokens: the `#`, `**`, `>` and link syntax stays quiet so
 *  the prose itself reads as the content. */
const proseHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.4em", fontWeight: "700" },
  { tag: tags.heading2, fontSize: "1.2em", fontWeight: "700" },
  { tag: tags.heading3, fontSize: "1.08em", fontWeight: "600" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "600" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--chart-1)", textDecoration: "underline" },
  { tag: tags.monospace, fontFamily: "var(--font-mono, ui-monospace, monospace)", backgroundColor: "var(--color-muted)" },
  { tag: tags.quote, color: "var(--color-muted-foreground)", fontStyle: "italic" },
  { tag: [tags.processingInstruction, tags.meta], color: "var(--color-muted-foreground)" },
]);

/**
 * A markdown editor should read like the document it becomes, not like source
 * code. This uses the app's own font and colours, pads the page, and drops the
 * line-number gutter that only makes sense for code.
 */
const proseTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--color-foreground)",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    fontSize: "0.875rem",
    lineHeight: "1.65",
  },
  ".cm-content": {
    padding: "16px 20px",
    caretColor: "var(--color-foreground)",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--color-foreground)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklch, var(--chart-1) 30%, transparent)",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklch, var(--chart-4) 25%, transparent)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklch, var(--chart-4) 35%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklch, var(--chart-4) 55%, transparent)",
  },
  ".cm-panels": {
    backgroundColor: "var(--color-background)",
    color: "var(--color-foreground)",
  },
});

const proseExtensions = [proseTheme, syntaxHighlighting(proseHighlight)];

function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function isProseLanguage(language?: string): boolean {
  return language === "markdown" || language === "mdx";
}

function themeFor(language?: string) {
  if (isProseLanguage(language)) return proseExtensions;
  // The same Pierre palette the code blocks and diffs use, so a code file does
  // not change colours when Edit is pressed.
  return pierreCodeTheme(isDark());
}

/** The language name `languageFromPath` gives a file, mapped to a CodeMirror
 *  mode. Anything without one edits as plain text — the old fallback was
 *  markdown, which highlighted code files as prose. */
function getLanguageExtension(language?: string) {
  switch (language) {
    case "javascript":
    case "jsx":
      return javascript({ jsx: true });
    case "typescript":
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return json();
    case "markdown":
    case "mdx":
      return markdown();
    case "yaml":
      return yaml();
    default:
      return [];
  }
}

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  className?: string;
  onSave?: () => void;
}

export function CodeEditor({ value, onChange, language, readOnly, className, onSave }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const languageCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const internalValue = useRef(value);
  const languageRef = useRef(language);

  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  languageRef.current = language;

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only; language/readOnly use compartments for live reconfiguration
  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: internalValue.current,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        themeCompartment.current.of(themeFor(language)),
        languageCompartment.current.of(getLanguageExtension(language)),
        readOnlyCompartment.current.of(EditorState.readOnly.of(!!readOnly)),
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString();
            internalValue.current = newValue;
            onChangeRef.current(newValue);
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Sync external value changes
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (value === internalValue.current) return;
    internalValue.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  // Sync theme
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const observer = new MutationObserver(() => {
      view.dispatch({
        effects: themeCompartment.current.reconfigure(themeFor(languageRef.current)),
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  // Sync language
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        languageCompartment.current.reconfigure(getLanguageExtension(language)),
        themeCompartment.current.reconfigure(themeFor(language)),
      ],
    });
  }, [language]);

  // Sync readOnly
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(!!readOnly)),
    });
  }, [readOnly]);

  return (
    <div
      ref={containerRef}
      className={`overflow-auto rounded-md border bg-background text-sm [&_.cm-editor]:min-h-[200px] [&_.cm-editor.cm-focused]:outline-none ${className || ""}`}
    />
  );
}

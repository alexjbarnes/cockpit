# Pierre Diffs Library Reference

Package: `@pierre/diffs` (React bindings at `@pierre/diffs/react`)

## Components

### PatchDiff

Takes a unified diff patch string. Parses it internally via `parsePatchFiles` -> `getSingularPatch`.

```tsx
<PatchDiff patch={diffString} options={{...}} />
```

Limitations:
- Cannot expand collapsed context. The renderer checks `ast.hunks == null` to decide if expansion is possible. Since PatchDiff always parses into hunks, `expandable` is always `false`. No expand buttons will ever render.
- Only has the lines present in the patch. No way to load more context.

Use PatchDiff only when you need a simple, read-only diff display with no expand functionality.

### FileDiff

Takes a pre-parsed `FileDiffMetadata` object. Supports context expansion when `oldLines` and `newLines` are provided.

```tsx
<FileDiff fileDiff={metadata} options={{...}} />
```

For expand to work, the `FileDiffMetadata` must have:
- `hunks` - parsed hunk structure (defines where changes are)
- `oldLines` - full old file content as `string[]` (each line must include trailing `\n`)
- `newLines` - full new file content as `string[]` (each line must include trailing `\n`)

When `oldLines`/`newLines` are present, the renderer takes the "two files" path in `renderDiffWithHighlighter`, producing a `code` object with `hunks == null`. This makes `expandable = true` in `DiffHunksRenderer.renderCollapsedHunks`.

### MultiFileDiff

Renders multiple file diffs. Not currently used in our codebase.

## Rendering Architecture

FileDiff and PatchDiff both render a `<diffs-container>` custom element with an **open Shadow DOM**. The shadow root contains:
- An SVG sprite sheet for icons
- A `<pre>` element with the actual diff content
- Adopted stylesheets from the library's CSS

Content is rendered asynchronously:
1. React renders `<diffs-container>` with a ref
2. Ref callback creates a `FileDiff` class instance and calls `hydrate()`
3. `hydrate()` calls `render()` which calls `renderDiff()` on `DiffHunksRenderer`
4. First render starts async syntax highlighting, returns null
5. When highlighting completes, `handleHighlightRender` triggers `rerender()`
6. Second render has cached result, injects DOM into the shadow root

Because of the Shadow DOM, standard CSS selectors and `querySelector` from outside will not reach diff content. Use `element.shadowRoot.querySelector()` or Playwright's `page.evaluate()` for testing.

## Key Options

```typescript
interface DiffOptions {
  theme: { dark: string; light: string };  // "pierre-dark", "pierre-light"
  themeType: "dark" | "light" | "system";
  overflow: "scroll" | "wrap";
  diffStyle: "split" | "unified";
  disableFileHeader: boolean;              // hide built-in file header
  hunkSeparators: "simple" | "metadata" | "line-info" | "custom";
  expansionLineCount: number;              // lines per expand click (default 100)
  expandUnchanged: boolean;                // expand all collapsed sections (default false)
  disableLineNumbers: boolean;
  disableBackground: boolean;
}
```

### hunkSeparators

- `"line-info"` - shows collapsed line count + expand buttons (recommended)
- `"metadata"` - shows raw hunk header metadata (e.g. `@@ -7,7 +7,7 @@`)
- `"simple"` - minimal visual separator, no text
- `"custom"` - renders a `<slot>` for custom content

### expansionLineCount

Controls how many lines are revealed per expand-button click. Default is 100. We use 20 for a more incremental expansion experience.

When `rangeSize > expansionLineCount`, the separator renders separate up/down expand buttons (`chunked` mode) instead of a single "expand all" button.

## Expand Button Internals

Expand buttons are created in `createSeparator()` (`utils/createSeparator.js`):
- `[data-expand-button]` - the clickable expand element
- `[data-expand-both]` - expand in both directions
- `[data-expand-up]` / `[data-expand-down]` - directional expand

The expand logic in `DiffHunksRenderer.expandHunk()`:
1. Tracks expanded regions per hunk index in `this.expandedHunks` Map
2. Each region has `fromStart` and `fromEnd` counts
3. Clicking expand adds `expansionLineCount` to the relevant direction
4. Calls `rerender()` to rebuild the DOM with more lines visible

## Line Format

When providing `oldLines`/`newLines` to `FileDiffMetadata`, each line **must** include a trailing newline character. The library's internal parser uses `SPLIT_WITH_NEWLINES = /(?<=\n)/` which preserves trailing newlines. If you split file content with `.split("\n")`, you must add newlines back:

```typescript
const lines = content.split("\n").map(l => l + "\n");
```

Without trailing newlines, `processLines()` in `renderDiffWithHighlighter` concatenates lines into a single string without separators, producing wrong line counts and rendering errors like `Invalid decoration position`.

## CSS and Styling

The library ships its own CSS via `style.js`, injected into the shadow root as an adopted stylesheet. Key selectors inside the shadow DOM:

- `[data-code]` - the main code container, has `overflow: scroll clip`
- `[data-diffs-header]` - built-in file header (inside `[data-code]`)
- `[data-separator]` - hunk separator elements
- `[data-column-content]` - individual line content cells

Because `[data-diffs-header]` sits inside `[data-code]` which has `overflow: scroll clip`, the built-in header cannot be made sticky relative to an outer scroll container. To get sticky file headers, render your own header outside the `FileDiff`/`PatchDiff` component with `position: sticky` and use `disableFileHeader: true`.

## Parsing Utilities

`parsePatchFiles(data: string)` - parses a unified or git diff string into `ParsedPatch[]`. Each patch has a `files: FileDiffMetadata[]` array. Exported from `@pierre/diffs`.

`getSingularPatch(patch: string)` - convenience wrapper that parses and asserts exactly one file. Used internally by PatchDiff.

## Our Implementation

We use `FileDiff` with:
1. API returns `{ diff, oldContent, newContent }` from `/api/git/diff`
2. Client parses `diff` with `parsePatchFiles` to get hunk structure
3. Attaches `oldLines`/`newLines` from full file contents (with trailing newlines)
4. Renders with `disableFileHeader: true` and a custom sticky header outside the component
5. `hunkSeparators: "line-info"` for expand buttons between hunks
6. `expansionLineCount: 20` for incremental context expansion

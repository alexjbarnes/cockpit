const MIN_LINES_FOR_COLLAPSE = 50;

export function shouldCollapsePaste(content: string): boolean {
  const lineCount = content.split("\n").length;
  return lineCount >= MIN_LINES_FOR_COLLAPSE;
}

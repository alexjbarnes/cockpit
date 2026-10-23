"use client";

/**
 * The line above a chart that says what is selected: a bucket's values when
 * one is tapped or hovered, the whole range's otherwise. Charts never rely on
 * a hover tooltip, which a phone cannot show.
 */
export function Readout({
  title,
  items,
  total,
  testId,
}: {
  title: string;
  items: Array<{ key: string; label: string; color: string; value: string }>;
  total?: string;
  testId?: string;
}) {
  return (
    <div className="min-h-[2.25rem] text-xs" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-foreground">{title}</span>
        {total !== undefined && <span className="tabular-nums text-foreground">{total}</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
        {items.map((item) => (
          <span key={item.key} className="inline-flex min-w-0 items-center gap-1">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: item.color }} />
            <span className="max-w-[12rem] truncate">{item.label}</span>
            <span className="tabular-nums text-foreground">{item.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

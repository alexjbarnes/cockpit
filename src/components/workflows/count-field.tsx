"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * A whole number that must be set, typed freely. The box holds what was typed,
 * so it can be emptied on the way to another number; the value only changes
 * once what is there is a number in range, and leaving the box with anything
 * else in it puts the last good value back.
 */
export function CountField({
  value,
  min,
  max,
  onCommit,
  className,
  testId,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
  className?: string;
  testId?: string;
  label?: string;
}) {
  const [text, setText] = useState(String(value));
  // The value changed from outside (a save, a discard, another tab): show it.
  useEffect(() => {
    setText((current) => (Number(current) === value ? current : String(value)));
  }, [value]);

  return (
    <Input
      inputMode="numeric"
      aria-label={label}
      className={className}
      data-testid={testId}
      value={text}
      onChange={(e) => {
        const digits = e.target.value.replace(/[^0-9]/g, "");
        setText(digits);
        const n = Number(digits);
        if (digits !== "" && n >= min && n <= max) onCommit(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

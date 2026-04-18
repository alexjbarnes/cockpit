"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface StringListEditorProps {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
}

export function StringListEditor({ value, onChange, placeholder = "Value" }: StringListEditorProps) {
  function updateItem(index: number, newValue: string) {
    const next = [...value];
    next[index] = newValue;
    onChange(next);
  }

  function addItem() {
    onChange([...value, ""]);
  }

  function removeItem(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-2">
      {value.map((item, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input
            className="flex-1 font-mono text-xs h-8"
            placeholder={placeholder}
            value={item}
            onChange={(e) => updateItem(idx, e.target.value)}
          />
          <button
            type="button"
            className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            onClick={() => removeItem(idx)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addItem}>
        <Plus className="h-3.5 w-3.5 mr-1" />
        Add
      </Button>
    </div>
  );
}

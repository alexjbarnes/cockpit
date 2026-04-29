"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface KeyValueEditorProps {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export function KeyValueEditor({ value, onChange, keyPlaceholder = "Key", valuePlaceholder = "Value" }: KeyValueEditorProps) {
  const entries = Object.entries(value);

  function updateKey(oldKey: string, newKey: string) {
    const result: Record<string, string> = {};
    for (const [k, v] of entries) {
      result[k === oldKey ? newKey : k] = v;
    }
    onChange(result);
  }

  function updateValue(key: string, newValue: string) {
    onChange({ ...value, [key]: newValue });
  }

  function addEntry() {
    let key = "";
    let i = 0;
    while (key in value) {
      i++;
      key = `key${i}`;
    }
    onChange({ ...value, [key]: "" });
  }

  function removeEntry(key: string) {
    const result = { ...value };
    delete result[key];
    onChange(result);
  }

  return (
    <div className="space-y-2">
      {entries.map(([k, v], idx) => (
        <div key={idx} className="flex items-center gap-2">
          <Input
            className="flex-1 font-mono text-xs h-8"
            placeholder={keyPlaceholder}
            value={k}
            onChange={(e) => updateKey(k, e.target.value)}
          />
          <Input
            className="flex-1 font-mono text-xs h-8"
            placeholder={valuePlaceholder}
            value={v}
            onChange={(e) => updateValue(k, e.target.value)}
          />
          <button
            type="button"
            className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
            onClick={() => removeEntry(k)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={addEntry}>
        <Plus className="h-3.5 w-3.5 mr-1" />
        Add
      </Button>
    </div>
  );
}

"use client";

import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { Provider, ProviderModel, ThinkingLevel } from "@/types";

interface ProviderFormProps {
  provider: Provider;
  isNew: boolean;
  onSave: (provider: Provider) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
  lockedEnvKeys?: string[];
}

const ALL_EFFORT_LEVELS: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];

function shouldMaskKey(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD/i.test(key) || key.toUpperCase().endsWith("_KEY");
}

interface EditingModel {
  index: number;
  modelId: string;
  displayName: string;
  effortLevels: ThinkingLevel[];
  supportsExtendedContext: boolean;
}

export function ProviderForm({ provider, isNew, onSave, onCancel, onDelete, lockedEnvKeys }: ProviderFormProps) {
  const [name, setName] = useState(provider.name);
  const [envVars, setEnvVars] = useState<[string, string][]>(Object.entries(provider.envVars));
  const [models, setModels] = useState<ProviderModel[]>(provider.models);
  const [newEnvKey, setNewEnvKey] = useState("");
  const [newEnvVal, setNewEnvVal] = useState("");
  const [newModelId, setNewModelId] = useState("");
  const [newModelName, setNewModelName] = useState("");
  const [newModelEffort, setNewModelEffort] = useState<ThinkingLevel[]>([]);
  const [newModelExtCtx, setNewModelExtCtx] = useState(false);
  const [editingModel, setEditingModel] = useState<EditingModel | null>(null);
  const locked = new Set(lockedEnvKeys ?? []);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        ...provider,
        name,
        envVars: Object.fromEntries(envVars),
        models,
      });
    } finally {
      setSaving(false);
    }
  };

  const addEnvVar = () => {
    if (newEnvKey.trim()) {
      setEnvVars([...envVars, [newEnvKey.trim(), newEnvVal]]);
      setNewEnvKey("");
      setNewEnvVal("");
    }
  };

  const addModel = () => {
    if (newModelId.trim()) {
      setModels([
        ...models,
        {
          modelId: newModelId.trim(),
          displayName: newModelName.trim() || newModelId.trim(),
          effortLevels: newModelEffort,
          supportsExtendedContext: newModelExtCtx,
        },
      ]);
      setNewModelId("");
      setNewModelName("");
      setNewModelEffort([]);
      setNewModelExtCtx(false);
    }
  };

  const saveEditingModel = () => {
    if (!editingModel) return;
    setModels(
      models.map((m, i) =>
        i === editingModel.index
          ? {
              modelId: editingModel.modelId.trim(),
              displayName: editingModel.displayName.trim() || editingModel.modelId.trim(),
              effortLevels: editingModel.effortLevels,
              supportsExtendedContext: editingModel.supportsExtendedContext,
            }
          : m,
      ),
    );
    setEditingModel(null);
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{isNew ? "Add Provider" : `Edit ${provider.name}`}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. OpenRouter" />
          </div>

          {/* Environment Variables */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Environment Variables</label>
            {envVars.length > 0 && (
              <div className="space-y-1.5">
                {envVars.map(([key, value], i) => {
                  const isLocked = locked.has(key);
                  const masked = shouldMaskKey(key);
                  return (
                    <div key={i} className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        {isLocked ? (
                          <span className="flex-1 min-w-0 font-mono text-xs h-8 flex items-center px-3 rounded border border-input bg-muted/50 text-muted-foreground">
                            {key}
                          </span>
                        ) : (
                          <>
                            <Input
                              value={key}
                              onChange={(e) => {
                                const next = [...envVars];
                                next[i] = [e.target.value, value];
                                setEnvVars(next);
                              }}
                              placeholder="KEY"
                              className="flex-1 min-w-0 font-mono text-xs h-8"
                            />
                            <button
                              type="button"
                              onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}
                              className="shrink-0 text-muted-foreground hover:text-foreground p-1"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                      <Input
                        type={masked ? "password" : "text"}
                        value={value}
                        onChange={(e) => {
                          const next = [...envVars];
                          next[i] = [key, e.target.value];
                          setEnvVars(next);
                        }}
                        placeholder={masked ? "••••••••" : "value"}
                        className="flex-1 min-w-0 font-mono text-xs h-8 w-full"
                      />
                    </div>
                  );
                })}
              </div>
            )}
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Input
                  value={newEnvKey}
                  onChange={(e) => setNewEnvKey(e.target.value)}
                  placeholder="KEY"
                  className="flex-1 min-w-0 font-mono text-xs h-8"
                  onKeyDown={(e) => e.key === "Enter" && addEnvVar()}
                />
                <button type="button" onClick={addEnvVar} className="shrink-0 text-muted-foreground hover:text-foreground p-1">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <Input
                type={shouldMaskKey(newEnvKey) ? "password" : "text"}
                value={newEnvVal}
                onChange={(e) => setNewEnvVal(e.target.value)}
                placeholder={shouldMaskKey(newEnvKey) ? "••••••••" : "value"}
                className="w-full font-mono text-xs h-8"
                onKeyDown={(e) => e.key === "Enter" && addEnvVar()}
              />
            </div>
          </div>

          {/* Models */}
          <div className="space-y-3">
            <label className="text-xs font-medium text-muted-foreground">Models</label>
            {models.length > 0 && (
              <div className="space-y-1">
                {models.map((model, i) =>
                  editingModel?.index === i ? (
                    <div key={i} className="rounded-md border border-border px-3 py-2 space-y-2">
                      <div className="flex gap-1.5">
                        <Input
                          value={editingModel.modelId}
                          onChange={(e) => setEditingModel({ ...editingModel, modelId: e.target.value })}
                          placeholder="Model ID"
                          className="flex-1 font-mono text-xs h-8"
                        />
                        <Input
                          value={editingModel.displayName}
                          onChange={(e) => setEditingModel({ ...editingModel, displayName: e.target.value })}
                          placeholder="Display name"
                          className="flex-1 text-xs h-8"
                        />
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">Thinking:</span>
                        {ALL_EFFORT_LEVELS.map((level) => (
                          <button
                            type="button"
                            key={level}
                            onClick={() =>
                              setEditingModel({
                                ...editingModel,
                                effortLevels: editingModel.effortLevels.includes(level)
                                  ? editingModel.effortLevels.filter((l) => l !== level)
                                  : [...editingModel.effortLevels, level],
                              })
                            }
                            className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                              editingModel.effortLevels.includes(level)
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                            }`}
                          >
                            {level}
                          </button>
                        ))}
                        <label className="flex items-center gap-1.5 ml-2 text-xs text-muted-foreground cursor-pointer">
                          <input
                            type="checkbox"
                            checked={editingModel.supportsExtendedContext}
                            onChange={(e) => setEditingModel({ ...editingModel, supportsExtendedContext: e.target.checked })}
                            className="rounded"
                          />
                          1M context
                        </label>
                      </div>
                      <div className="flex gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={saveEditingModel}
                          disabled={!editingModel.modelId.trim()}
                        >
                          <Check className="h-3 w-3 mr-1" /> Save
                        </Button>
                        <Button type="button" size="sm" variant="ghost" onClick={() => setEditingModel(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div key={i} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
                      <span className="font-mono font-medium">{model.modelId}</span>
                      {model.displayName !== model.modelId && <span className="text-muted-foreground">{model.displayName}</span>}
                      <div className="ml-auto flex items-center gap-1.5">
                        {model.effortLevels.length > 0 && (
                          <span className="text-muted-foreground">thinking: {model.effortLevels.join(", ")}</span>
                        )}
                        {model.supportsExtendedContext && <span className="text-muted-foreground">1M</span>}
                        <button
                          type="button"
                          onClick={() =>
                            setEditingModel({
                              index: i,
                              modelId: model.modelId,
                              displayName: model.displayName,
                              effortLevels: model.effortLevels,
                              supportsExtendedContext: model.supportsExtendedContext ?? false,
                            })
                          }
                          className="shrink-0 text-muted-foreground hover:text-foreground p-0.5"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setModels(models.filter((_, j) => j !== i))}
                          className="shrink-0 text-muted-foreground hover:text-foreground p-0.5"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
            {models.length === 0 && <p className="text-xs text-muted-foreground">No models configured for this provider.</p>}

            {/* Add model form */}
            <div className="rounded-md border border-dashed border-input p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Add a model</p>
              <Input
                value={newModelId}
                onChange={(e) => setNewModelId(e.target.value)}
                placeholder="Model ID (e.g. openai/gpt-4o)"
                className="font-mono text-xs h-8"
                onKeyDown={(e) => e.key === "Enter" && addModel()}
              />
              <Input
                value={newModelName}
                onChange={(e) => setNewModelName(e.target.value)}
                placeholder="Display name (e.g. GPT-4o)"
                className="text-xs h-8"
                onKeyDown={(e) => e.key === "Enter" && addModel()}
              />
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs text-muted-foreground">Thinking:</span>
                {ALL_EFFORT_LEVELS.map((level) => (
                  <button
                    type="button"
                    key={level}
                    onClick={() => setNewModelEffort((prev) => (prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]))}
                    className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                      newModelEffort.includes(level)
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    }`}
                  >
                    {level}
                  </button>
                ))}
                <label className="flex items-center gap-1.5 ml-2 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newModelExtCtx}
                    onChange={(e) => setNewModelExtCtx(e.target.checked)}
                    className="rounded"
                  />
                  1M context
                </label>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addModel} disabled={!newModelId.trim()}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add model
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <div>
          {onDelete && (
            <Button variant="outline" size="sm" className="text-destructive" onClick={onDelete}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete provider
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!name.trim() || saving}>
            {saving ? "Saving..." : isNew ? "Create" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );
}

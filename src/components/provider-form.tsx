"use client";

import { Cpu, Key, Layers, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
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

type Tab = "general" | "models";

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

function EffortPills({ selected, onChange }: { selected: ThinkingLevel[]; onChange: (levels: ThinkingLevel[]) => void }) {
  return (
    <div className="ml-auto flex flex-wrap gap-1 justify-end">
      {ALL_EFFORT_LEVELS.map((level) => (
        <button
          type="button"
          key={level}
          onClick={() => onChange(selected.includes(level) ? selected.filter((l) => l !== level) : [...selected, level])}
          className={`rounded px-2 py-0.5 text-xs transition-colors ${
            selected.includes(level) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          {level}
        </button>
      ))}
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

export function ProviderForm({ provider, isNew, onSave, onCancel, onDelete, lockedEnvKeys }: ProviderFormProps) {
  const [tab, setTab] = useState<Tab>("general");
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
  const [saving, setSaving] = useState(false);
  const locked = new Set(lockedEnvKeys ?? []);

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
    <div className="flex flex-col h-full">
      <div className="flex gap-1 px-1 pb-3 border-b shrink-0">
        <TabButton active={tab === "general"} onClick={() => setTab("general")} icon={<Key className="h-3.5 w-3.5" />} label="General" />
        <TabButton active={tab === "models"} onClick={() => setTab("models")} icon={<Layers className="h-3.5 w-3.5" />} label="Models" />
      </div>

      <div className="flex-1 overflow-y-auto py-4 space-y-4">
        {tab === "general" && (
          <div className="space-y-4 sm:space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2">
              <div className="flex items-center gap-2">
                <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Name</span>
              </div>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. OpenRouter"
                className="sm:ml-auto sm:w-56 text-xs h-7"
              />
            </div>

            <div className="space-y-2 sm:space-y-3">
              <div className="flex items-center gap-2">
                <Key className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">Environment Variables</span>
              </div>

              <div className="space-y-1.5">
                {envVars.map(([key, value], i) => {
                  const isLocked = locked.has(key);
                  const masked = shouldMaskKey(key);
                  return (
                    <div key={i} className="rounded-lg border border-border px-3 py-2 text-xs space-y-1.5">
                      <div className="flex items-center gap-2">
                        {isLocked ? (
                          <span className="font-mono text-muted-foreground truncate">{key}</span>
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
                              className="flex-1 min-w-0 font-mono text-xs h-7"
                            />
                            <button
                              type="button"
                              onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}
                              className="shrink-0 text-muted-foreground hover:text-foreground p-0.5"
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
                        className="w-full font-mono text-xs h-7"
                      />
                    </div>
                  );
                })}
              </div>

              <div className="rounded-lg border border-dashed border-input px-3 py-2 space-y-1.5">
                <div className="flex items-center gap-2">
                  <Input
                    value={newEnvKey}
                    onChange={(e) => setNewEnvKey(e.target.value)}
                    placeholder="NEW_KEY"
                    className="flex-1 min-w-0 font-mono text-xs h-7"
                    onKeyDown={(e) => e.key === "Enter" && addEnvVar()}
                  />
                  <button type="button" onClick={addEnvVar} className="shrink-0 text-muted-foreground hover:text-foreground p-0.5">
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
                <Input
                  type={shouldMaskKey(newEnvKey) ? "password" : "text"}
                  value={newEnvVal}
                  onChange={(e) => setNewEnvVal(e.target.value)}
                  placeholder={shouldMaskKey(newEnvKey) ? "••••••••" : "value"}
                  className="w-full font-mono text-xs h-7"
                  onKeyDown={(e) => e.key === "Enter" && addEnvVar()}
                />
              </div>
            </div>
          </div>
        )}

        {tab === "models" && (
          <div className="space-y-4">
            {models.length === 0 && !editingModel && (
              <p className="text-xs text-muted-foreground py-4 text-center">No models configured yet.</p>
            )}

            <div className="space-y-1">
              {models.map((model, i) =>
                editingModel?.index === i ? (
                  <div key={i} className="rounded-lg border border-primary/30 bg-primary/5 px-3 sm:px-4 py-3 space-y-3">
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Input
                        value={editingModel.modelId}
                        onChange={(e) => setEditingModel({ ...editingModel, modelId: e.target.value })}
                        placeholder="Model ID"
                        className="flex-1 font-mono text-xs h-7"
                      />
                      <Input
                        value={editingModel.displayName}
                        onChange={(e) => setEditingModel({ ...editingModel, displayName: e.target.value })}
                        placeholder="Display name"
                        className="flex-1 text-xs h-7"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Thinking</span>
                      <EffortPills
                        selected={editingModel.effortLevels}
                        onChange={(levels) => setEditingModel({ ...editingModel, effortLevels: levels })}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editingModel.supportsExtendedContext}
                          onChange={(e) => setEditingModel({ ...editingModel, supportsExtendedContext: e.target.checked })}
                          className="rounded"
                        />
                        1M context
                      </label>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setEditingModel(null)}
                          className="px-2.5 py-1 text-xs rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={saveEditingModel}
                          disabled={!editingModel.modelId.trim()}
                          className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:brightness-110 transition-all disabled:opacity-50"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <button
                    key={i}
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
                    className="flex w-full items-center gap-2 sm:gap-3 rounded-lg border border-border px-3 sm:px-4 py-2.5 text-xs hover:bg-muted/50 transition-colors text-left"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center gap-0.5 sm:gap-3 min-w-0 flex-1">
                      <span className="font-mono font-medium truncate">{model.modelId}</span>
                      {model.displayName !== model.modelId && <span className="text-muted-foreground truncate">{model.displayName}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {model.effortLevels.length > 0 && (
                        <span className="text-muted-foreground hidden sm:inline">{model.effortLevels.join(", ")}</span>
                      )}
                      {model.supportsExtendedContext && <span className="text-muted-foreground">1M</span>}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setModels(models.filter((_, j) => j !== i));
                        }}
                        className="text-muted-foreground hover:text-destructive p-0.5"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </button>
                ),
              )}
            </div>

            <div className="rounded-lg border border-dashed border-input px-3 sm:px-4 py-3 space-y-3">
              <div className="flex flex-col sm:flex-row gap-2">
                <Input
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  placeholder="Model ID (e.g. openai/gpt-4o)"
                  className="flex-1 font-mono text-xs h-7"
                  onKeyDown={(e) => e.key === "Enter" && addModel()}
                />
                <Input
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  placeholder="Display name"
                  className="flex-1 text-xs h-7"
                  onKeyDown={(e) => e.key === "Enter" && addModel()}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Thinking</span>
                <EffortPills selected={newModelEffort} onChange={setNewModelEffort} />
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newModelExtCtx}
                    onChange={(e) => setNewModelExtCtx(e.target.checked)}
                    className="rounded"
                  />
                  1M context
                </label>
                <button
                  type="button"
                  onClick={addModel}
                  disabled={!newModelId.trim()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  Add model
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between pt-3 border-t shrink-0">
        <div>
          {onDelete && (
            <button
              onClick={onDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-md border border-input text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || saving}
            className="px-4 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:brightness-110 transition-all disabled:opacity-50"
          >
            {saving ? "Saving..." : isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

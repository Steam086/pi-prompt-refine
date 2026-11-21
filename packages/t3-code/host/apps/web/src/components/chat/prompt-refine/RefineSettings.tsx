import { useState } from "react";
import type { DesktopCall, DesktopSettings, SettingsFields } from "@t3tools/prompt-refine/protocol";
import { Button } from "~/components/ui/button";

type Save = Extract<DesktopCall, { method: "saveSettings" | "saveOptimizer" }>;
type Numeric =
  | "maxMessages"
  | "historyMaxChars"
  | "maxOutputTokens"
  | "timeoutMs"
  | "maxDraftChars";
const limits: Record<Numeric, [label: string, minimum: number, maximum: number]> = {
  maxMessages: ["History messages", 0, 50],
  historyMaxChars: ["History characters", 0, 100_000],
  maxOutputTokens: ["Output token limit", 16, 65_536],
  timeoutMs: ["Request timeout (seconds)", 1, 300],
  maxDraftChars: ["Draft character limit", 1, 100_000],
};
const control = "min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-sm";

export function RefineSettings({
  value,
  disabled,
  save,
}: {
  value: DesktopSettings;
  disabled: boolean;
  save: (
    call:
      | Omit<Extract<Save, { method: "saveSettings" }>, "binding">
      | Omit<Extract<Save, { method: "saveOptimizer" }>, "binding">,
  ) => Promise<boolean>;
}) {
  const [group, setGroup] = useState<"Optimizer" | "Context">("Optimizer");
  const [fields, setFields] = useState<Partial<SettingsFields>>({});
  const [model, setModel] = useState<string>();
  const [thinking, setThinking] = useState<DesktopSettings["optimizer"]["thinking"]>();
  const [saved, setSaved] = useState("");
  const [confirmPrompt, setConfirmPrompt] = useState(false);
  const modelKey = ({ provider, id }: { provider: string; id: string }) =>
    JSON.stringify([provider, id]);
  const chosen = model ?? (value.optimizer.model ? modelKey(value.optimizer.model) : "");
  const selected = value.models.find((entry) => modelKey(entry) === chosen);
  const level = thinking ?? value.optimizer.thinking;
  const draft = { ...value.fields, ...fields };
  const editingDisabled = disabled || !value.writable;
  const setField = <K extends keyof SettingsFields>(name: K, entry: SettingsFields[K]) =>
    setFields((current) => ({ ...current, [name]: entry }));

  async function saveFields(next: Partial<SettingsFields>) {
    setSaved("");
    if (!(await save({ method: "saveSettings", version: value.version, fields: next }))) return;
    setFields((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([key, entry]) => next[key as keyof SettingsFields] !== entry,
        ),
      ),
    );
    setSaved("Saved");
  }
  const otherFields = Object.fromEntries(
    Object.entries(fields).filter(([key]) => key !== "systemPrompt"),
  );
  const number = (key: Numeric) => {
    const [label, min, max] = limits[key];
    const scale = key === "timeoutMs" ? 1_000 : 1;
    return (
      <label key={key} className="grid gap-1 text-sm">
        {label}
        <input
          className={control}
          type="number"
          min={min}
          max={max}
          step={scale === 1 ? 1 : 0.001}
          value={Number.isFinite(draft[key]) ? draft[key] / scale : ""}
          onChange={(event) => setField(key, event.currentTarget.valueAsNumber * scale)}
        />
      </label>
    );
  };
  const check = (
    key: "projectContext" | "directoryTree" | "directoryReferences" | "skillMetadata",
    label: string,
  ) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={draft[key]}
        disabled={key !== "projectContext" && !draft.projectContext}
        onChange={(event) => setField(key, event.currentTarget.checked)}
      />
      {label}
    </label>
  );

  return (
    <div
      className="grid gap-3"
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.key.toLowerCase() !== "s" ||
          !event.ctrlKey ||
          event.metaKey
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (!editingDisabled && Object.keys(otherFields).length) void saveFields(otherFields);
      }}
    >
      <div className="flex gap-2">
        {(["Optimizer", "Context"] as const).map((name) => (
          <Button
            key={name}
            type="button"
            size="sm"
            variant={group === name ? "secondary" : "ghost"}
            aria-pressed={group === name}
            onClick={() => setGroup(name)}
          >
            {name}
          </Button>
        ))}
      </div>
      <fieldset className="grid gap-3" disabled={editingDisabled}>
        {group === "Optimizer" ? (
          <>
            <label className="grid gap-1 text-sm">
              Optimizer model
              <select
                className={control}
                value={selected ? chosen : ""}
                onChange={(event) => {
                  setModel(event.target.value);
                  setThinking("inherit");
                }}
              >
                <option value="" disabled>
                  Choose a model
                </option>
                {value.models.map((entry) => (
                  <option key={modelKey(entry)} value={modelKey(entry)}>
                    {entry.provider} / {entry.name}
                  </option>
                ))}
              </select>
            </label>
            {value.models.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Configure model credentials for the server’s Pi SDK.
              </p>
            )}
            <label className="grid gap-1 text-sm">
              Thinking
              <select
                className={control}
                disabled={!selected}
                value={level}
                onChange={(event) => setThinking(event.target.value as typeof level)}
              >
                <option value="inherit">Default</option>
                {selected?.thinkingLevels.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              variant="secondary"
              className="justify-self-start"
              disabled={!selected || (model === undefined && thinking === undefined)}
              onClick={() => {
                if (!selected) return;
                void save({
                  method: "saveOptimizer",
                  version: value.version,
                  model: { id: selected.id, provider: selected.provider },
                  thinking: level,
                }).then((ok) => {
                  if (ok) {
                    setModel(undefined);
                    setThinking(undefined);
                    setSaved("Optimizer saved");
                  }
                });
              }}
            >
              Save optimizer
            </Button>
            <label className="grid gap-1 text-sm">
              Optimization prompt
              <textarea
                className={control}
                rows={4}
                maxLength={16_000}
                value={draft.systemPrompt}
                placeholder="Use the built-in policy"
                onChange={(event) => {
                  setField("systemPrompt", event.target.value);
                  setConfirmPrompt(false);
                }}
                onKeyDown={(event) => {
                  if (
                    event.nativeEvent.isComposing ||
                    event.key.toLowerCase() !== "s" ||
                    !event.ctrlKey ||
                    event.metaKey
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (fields.systemPrompt !== undefined) setConfirmPrompt(true);
                }}
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              className="justify-self-start"
              disabled={fields.systemPrompt === undefined}
              onClick={() => {
                if (!confirmPrompt) {
                  setConfirmPrompt(true);
                  return;
                }
                setConfirmPrompt(false);
                void saveFields({ systemPrompt: draft.systemPrompt });
              }}
            >
              {confirmPrompt ? "Confirm policy for new rounds" : "Save prompt"}
            </Button>
            {confirmPrompt && (
              <Button
                type="button"
                variant="ghost"
                className="justify-self-start"
                onClick={() => setConfirmPrompt(false)}
              >
                Cancel policy change
              </Button>
            )}
            <div className="grid gap-2 sm:grid-cols-3">
              {number("maxOutputTokens")}
              {number("timeoutMs")}
              {number("maxDraftChars")}
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-2">
              {number("maxMessages")}
              {number("historyMaxChars")}
            </div>
            {check("projectContext", "Project context")}
            <label className="grid gap-1 text-sm">
              Project instructions
              <select
                className={control}
                value={draft.instructions}
                disabled={!draft.projectContext}
                onChange={(event) =>
                  setField("instructions", event.target.value as SettingsFields["instructions"])
                }
              >
                <option value="off">Off</option>
                <option value="first">First request only</option>
                <option value="always">Always</option>
              </select>
            </label>
            {check("directoryTree", "Directory tree")}
            {check("directoryReferences", "Directory references")}
            {check("skillMetadata", "Skill metadata")}
            <p className="text-xs text-muted-foreground">
              Context changes apply when the next round captures its first draft.
            </p>
          </>
        )}
        <div className="flex items-center justify-between gap-2">
          <span role="status" className="text-sm text-muted-foreground">
            {saved}
          </span>
          <Button
            type="button"
            disabled={!Object.keys(otherFields).length}
            onClick={() => void saveFields(otherFields)}
          >
            Save
          </Button>
        </div>
      </fieldset>
    </div>
  );
}

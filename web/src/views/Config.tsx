import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, Circle, CircleDot, FolderGit2, Plus, Trash2, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProjectIcon } from "@/components/ProjectIcon";
import { useProjectColor } from "@/lib/project-color";
import { api, type AppConfig, type RepoConfigInput } from "@/lib/api";

/** A small section heading matching the dashboard/tasks group titles. */
function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</h2>;
}

/** One label/value row in the key→value settings grids. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-2.5">
      <span className="w-40 shrink-0 text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words text-sm font-medium">{children}</span>
    </div>
  );
}

/** Monospace value for paths, models, and other literal config strings. */
function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[13px]">{children}</code>;
}

function YesNo({ value }: { value: boolean }) {
  return value ? (
    <span className="inline-flex items-center gap-1 text-success">
      <Check className="size-4" /> Configured
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-danger">
      <X className="size-4" /> Not set
    </span>
  );
}

/** A field label above an editable input. */
function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-xs text-muted-foreground">{children}</span>;
}

/**
 * Edits a string-array field (prefixes, labels) as removable chips plus an input
 * that adds entries on Enter or comma. Case-insensitive de-dupe.
 */
function ChipInput({
  values,
  placeholder,
  onChange,
}: {
  values: string[];
  placeholder: string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const additions = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (additions.length === 0) return;
    const next = [...values];
    for (const a of additions) {
      if (!next.some((v) => v.toLowerCase() === a.toLowerCase())) next.push(a);
    }
    onChange(next);
    setDraft("");
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md inset-ring inset-ring-input bg-transparent p-1.5 dark:bg-input/30">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded-sm bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${v}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={values.length === 0 ? placeholder : ""}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        className="min-w-[8ch] flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

/** Map the API view to the editable input shape (drops derived iconUrl). */
function toInput(r: AppConfig["repos"][number]): RepoConfigInput {
  return {
    name: r.name,
    localPath: r.localPath,
    defaultBranch: r.defaultBranch,
    issuePrefixes: r.issuePrefixes,
    labels: r.labels,
    icon: r.icon,
    gradient: r.gradient,
    qaGate: r.qaGate,
    qaPort: r.qaPort,
    qaCompanionPath: r.qaCompanionPath,
    stagingUrl: r.stagingUrl,
  };
}

function emptyRepo(): RepoConfigInput {
  return { name: "", localPath: "", defaultBranch: "main", issuePrefixes: [], labels: [], icon: "", gradient: "", qaGate: false, qaPort: null, qaCompanionPath: "", stagingUrl: "" };
}

/**
 * Picks the project's accent color. Empty value = "auto" — the swatch then shows
 * the color sampled from the icon, which is what the cards use. Picking a color
 * sets an explicit override; "Reset to icon" clears it back to auto.
 */
function GradientField({
  repo,
  iconUrl,
  value,
  onChange,
}: {
  repo: string;
  iconUrl: string | null;
  value: string;
  onChange: (next: string) => void;
}) {
  const derived = useProjectColor(repo || iconUrl || "project", iconUrl, "");
  const effective = value.trim() || derived;
  return (
    <div>
      <FieldLabel>Accent color — tints the card's icon tray (defaults to the icon's color)</FieldLabel>
      <div className="flex items-center gap-2.5">
        <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-border">
          <span className="absolute inset-0" style={{ backgroundColor: effective }} />
          <input
            type="color"
            value={effective}
            onChange={(e) => onChange(e.target.value)}
            aria-label="Project gradient color"
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[13px]">
          {value.trim() || `auto · ${derived}`}
        </code>
        {value.trim() && (
          <Button variant="ghost" size="sm" onClick={() => onChange("")}>
            Reset to icon
          </Button>
        )}
      </div>
    </div>
  );
}

export function Config() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState(false);

  // Editable draft of the repos array, seeded from the loaded config.
  const [repos, setRepos] = useState<RepoConfigInput[]>([]);
  const [original, setOriginal] = useState<RepoConfigInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Default-model selection persists immediately on click, independent of the
  // repos draft above.
  const [savingModel, setSavingModel] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  function seed(c: AppConfig) {
    setConfig(c);
    const inputs = c.repos.map(toInput);
    setRepos(inputs);
    setOriginal(inputs);
  }

  useEffect(() => {
    api.config().then(seed).catch(() => setError(true));
  }, []);

  const dirty = useMemo(() => JSON.stringify(repos) !== JSON.stringify(original), [repos, original]);

  function update(i: number, patch: Partial<RepoConfigInput>) {
    setRepos((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const next = await api.saveRepos(repos);
      seed(next);
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function selectDefaultModel(id: string) {
    if (!config || id === config.defaultModel || savingModel) return;
    setSavingModel(true);
    setModelError(null);
    try {
      const next = await api.saveDefaultModel(id);
      // Only adopt the model fields — leave any in-progress repos draft untouched.
      setConfig((c) => (c ? { ...c, defaultModel: next.defaultModel } : c));
    } catch (e) {
      setModelError(e instanceof Error ? e.message.replace(/^\d+:\s*/, "") : "Failed to save");
    } finally {
      setSavingModel(false);
    }
  }

  if (error) {
    return <p className="text-sm text-danger">Could not load configuration — is the runner running?</p>;
  }
  if (!config) {
    return <p className="text-sm text-muted-foreground">Loading configuration…</p>;
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Configuration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Repositories are editable and saved to <Mono>config.json</Mono> — no restart or code change needed. Other
          settings are read-only environment values.
        </p>
      </div>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <SectionTitle>Repositories ({repos.length})</SectionTitle>
          <Button variant="outline" size="sm" onClick={() => setRepos((p) => [...p, emptyRepo()])}>
            <Plus className="size-4" /> Add repository
          </Button>
        </div>

        <div className="space-y-3">
          {repos.map((repo, i) => {
            const iconUrl = original.find((o) => o.name === repo.name)?.icon === repo.icon
              ? config.repos.find((r) => r.name === repo.name)?.iconUrl ?? null
              : null;
            return (
              <Card key={i} className="gap-0 py-4">
                <CardContent className="space-y-3">
                  <div className="flex items-center gap-3">
                    {iconUrl ? (
                      <ProjectIcon src={iconUrl} repo={repo.name} />
                    ) : (
                      <FolderGit2 className="size-6 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex-1">
                      <FieldLabel>Name</FieldLabel>
                      <Input
                        value={repo.name}
                        placeholder="my-repo"
                        onChange={(e) => update(i, { name: e.target.value })}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="mt-5 text-muted-foreground hover:text-danger"
                      onClick={() => setRepos((p) => p.filter((_, idx) => idx !== i))}
                      aria-label="Remove repository"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <FieldLabel>Local path</FieldLabel>
                      <Input
                        value={repo.localPath}
                        placeholder="/path/to/repo"
                        onChange={(e) => update(i, { localPath: e.target.value })}
                      />
                    </div>
                    <div>
                      <FieldLabel>Default branch</FieldLabel>
                      <Input
                        value={repo.defaultBranch}
                        placeholder="main"
                        onChange={(e) => update(i, { defaultBranch: e.target.value })}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <FieldLabel>Title prefixes (e.g. Web → matches "Web: …")</FieldLabel>
                      <ChipInput
                        values={repo.issuePrefixes}
                        placeholder="Add prefix…"
                        onChange={(next) => update(i, { issuePrefixes: next })}
                      />
                    </div>
                    <div>
                      <FieldLabel>
                        Labels {repo.labels.length === 0 && "(empty → falls back to prefixes)"}
                      </FieldLabel>
                      <ChipInput
                        values={repo.labels}
                        placeholder="Add label…"
                        onChange={(next) => update(i, { labels: next })}
                      />
                    </div>
                  </div>

                  <div>
                    <FieldLabel>Icon (http(s) URL or local file path — optional)</FieldLabel>
                    <Input
                      value={repo.icon}
                      placeholder="https://… or /path/to/favicon.png"
                      onChange={(e) => update(i, { icon: e.target.value })}
                    />
                  </div>

                  <GradientField
                    repo={repo.name}
                    iconUrl={iconUrl}
                    value={repo.gradient}
                    onChange={(next) => update(i, { gradient: next })}
                  />

                  <div>
                    <FieldLabel>
                      QA companion repo path (optional) — a second clone testers check the loop's branch out into
                    </FieldLabel>
                    <Input
                      value={repo.qaCompanionPath}
                      placeholder="/path/to/my-repo-qa"
                      onChange={(e) => update(i, { qaCompanionPath: e.target.value })}
                    />
                  </div>

                  <div>
                    <FieldLabel>Staging URL (optional) — a shared deploy other branches can overwrite; shown as a quick link</FieldLabel>
                    <Input
                      value={repo.stagingUrl}
                      placeholder="http://staging.internal"
                      onChange={(e) => update(i, { stagingUrl: e.target.value })}
                    />
                  </div>

                  <label className="flex cursor-pointer items-center gap-2.5 rounded-md bg-muted/20 px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={repo.qaGate ?? false}
                      onChange={(e) => update(i, { qaGate: e.target.checked })}
                      className="size-4 accent-info"
                    />
                    <span className="text-sm font-medium">QA smoke gate</span>
                    <span className="text-xs text-muted-foreground">
                      Boot the app, drive the affected flow, and screenshot it before review.
                      Requires a <Mono>/loop-qa</Mono> profile for this repo.
                    </span>
                  </label>

                  {repo.qaGate && (
                    <label className="flex items-center gap-2.5 rounded-md bg-muted/20 px-3 py-2.5">
                      <span className="text-sm font-medium">QA port</span>
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        value={repo.qaPort ?? ""}
                        placeholder="3000"
                        onChange={(e) =>
                          update(i, { qaPort: e.target.value === "" ? null : Number(e.target.value) })
                        }
                        className="w-24 rounded-md inset-ring inset-ring-input bg-background px-2 py-1 text-sm"
                      />
                      <span className="text-xs text-muted-foreground">
                        Dev-server port the gate serves on (leased so loops don't collide). Default 3000.
                      </span>
                    </label>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {repos.length === 0 && (
            <Card className="py-4">
              <CardContent className="text-sm text-muted-foreground">
                No repositories configured. Add one to enable issue→repo matching.
              </CardContent>
            </Card>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save repositories"}
          </Button>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => setRepos(original)} disabled={saving}>
              Reset
            </Button>
          )}
          {saveError && <span className="text-sm text-danger">{saveError}</span>}
          {saved && !dirty && (
            <span className="inline-flex items-center gap-1 text-sm text-success">
              <Check className="size-4" /> Saved
            </span>
          )}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center gap-3">
          <SectionTitle>Default model</SectionTitle>
          {modelError && <span className="text-sm text-danger">{modelError}</span>}
        </div>
        <p className="mb-3 -mt-1 text-sm text-muted-foreground">
          Used for a Loop when no model is chosen at start. Saved to <Mono>config.json</Mono> and applied immediately —
          no restart needed.
        </p>
        <Card className="gap-0 py-2">
          <CardContent className="px-0">
            {config.models.map((model) => {
              const active = model.id === config.defaultModel;
              return (
                <button
                  key={model.id}
                  type="button"
                  disabled={savingModel}
                  onClick={() => selectDefaultModel(model.id)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {active ? (
                    <CircleDot className="size-4 shrink-0 text-info" />
                  ) : (
                    <Circle className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="w-40 shrink-0 text-sm font-medium">{model.label}</span>
                  <span className="min-w-0 flex-1">
                    <Mono>{model.id}</Mono>
                    {active && (
                      <span className="ml-2 rounded-sm bg-info-soft px-1.5 py-0.5 text-[10px] font-medium text-info">
                        default
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </CardContent>
        </Card>
      </section>

      <section>
        <SectionTitle>Runner (environment)</SectionTitle>
        <Card className="gap-0 py-2">
          <CardContent className="divide-y px-0">
            <Row label="Linear API key">
              <YesNo value={config.linearConfigured} />
            </Row>
            <Row label="Port">
              <Mono>{config.port}</Mono>
            </Row>
            <Row label="Max parallel loops">{config.maxParallelLoops}</Row>
            <Row label="Max iterations">{config.maxIterations}</Row>
            <Row label="Data directory">
              <Mono>{config.dataDir}</Mono>
            </Row>
            <Row label="Log file">
              <Mono>{config.logFile}</Mono>
            </Row>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

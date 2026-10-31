"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { usePipelines } from "@/hooks/use-pipelines";
import { canonicalStageDefs } from "@/lib/pipelines/resolve";
import {
  DEFAULT_PIPELINE_ID,
  MAX_PIPELINES_PER_SUB_ACCOUNT,
  MAX_STAGES_PER_PIPELINE,
  STAGE_TONES,
} from "@/types/pipelines";
import type { ResolvedPipeline } from "@/types/pipelines";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Pipelines manager (admin-only): create/rename/delete pipelines and edit their
 * stages. Removing an occupied stage needs a destination; the server refuses with
 * per-stage deal counts until one is picked. Each pipeline keeps exactly one Won
 * and one Lost stage (renameable, never removable) since they anchor revenue
 * reports, quote-to-Won automation and lost-reason prompts.
 *
 * The default pipeline is virtual (canonical six + legacy overrides) until its
 * first save materializes `pipelines/default` server-side.
 */

interface StageRow {
  /** Existing stage id; null = new stage (server mints the slug). */
  id: string | null;
  label: string;
  tone: string;
  terminal?: "won" | "lost";
}

function rowsFromPipeline(p: ResolvedPipeline): StageRow[] {
  return p.stages.map((s) => ({
    id: s.id,
    label: s.label,
    tone: s.tone,
    terminal: s.terminal,
  }));
}

export function SubAccountPipelineSection() {
  const { isAdmin } = useSubAccount();
  const { pipelines, hydrated } = usePipelines();
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (!isAdmin) return null;

  const atCap = pipelines.length >= MAX_PIPELINES_PER_SUB_ACCOUNT;

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <GitBranch className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Pipelines</h2>
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
              Beta
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Run separate boards for different processes — e.g. a Sales
            pipeline and a Fulfillment pipeline — each with its own custom
            stages. Every pipeline keeps one Won and one Lost stage (rename
            them freely; they drive reports and automations).
          </p>
        </div>
      </div>

      {!hydrated ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading pipelines…
        </div>
      ) : (
        <div className="space-y-2">
          {pipelines.map((p) => (
            <PipelineEditor
              key={p.id}
              pipeline={p}
              open={openId === p.id}
              onToggle={() => setOpenId(openId === p.id ? null : p.id)}
              canDelete={p.id !== DEFAULT_PIPELINE_ID}
            />
          ))}

          {creating ? (
            <NewPipelineEditor onDone={() => setCreating(false)} />
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={atCap}
              onClick={() => setCreating(true)}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              {atCap
                ? `Pipeline limit reached (${MAX_PIPELINES_PER_SUB_ACCOUNT})`
                : "Add pipeline"}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** Stage-rows editor shared by the edit and create flows. */
function StageRowsEditor({
  rows,
  setRows,
  disabled,
}: {
  rows: StageRow[];
  setRows: (fn: (prev: StageRow[]) => StageRow[]) => void;
  disabled: boolean;
}) {
  function move(index: number, dir: -1 | 1) {
    setRows((prev) => {
      const next = [...prev];
      const j = index + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
  }

  return (
    <>
      <ul className="space-y-2">
        {rows.map((r, i) => (
          <li
            key={r.id ?? `new-${i}`}
            className="flex items-center gap-2 rounded-lg border bg-background p-2"
          >
            <div className="flex flex-col">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={disabled || i === 0}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Move up"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={disabled || i === rows.length - 1}
                className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                title="Move down"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <select
              value={
                STAGE_TONES.find((t) => t.tone === r.tone)?.id ??
                STAGE_TONES[0].id
              }
              onChange={(e) => {
                const tone =
                  STAGE_TONES.find((t) => t.id === e.target.value)?.tone ??
                  STAGE_TONES[0].tone;
                setRows((prev) =>
                  prev.map((row, j) => (j === i ? { ...row, tone } : row)),
                );
              }}
              disabled={disabled}
              className="h-8 rounded-md border bg-background px-1.5 text-xs [&_option]:bg-background [&_option]:text-foreground"
              title="Stage color"
            >
              {STAGE_TONES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <span
              className={cn(
                "h-2.5 w-2.5 shrink-0 rounded-full",
                r.tone.split(" ")[0],
              )}
              aria-hidden
            />
            <Input
              value={r.label}
              onChange={(e) =>
                setRows((prev) =>
                  prev.map((row, j) =>
                    j === i ? { ...row, label: e.target.value } : row,
                  ),
                )
              }
              maxLength={30}
              disabled={disabled}
              className="h-8 flex-1"
            />
            {r.terminal ? (
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize",
                  r.terminal === "won"
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-rose-500/10 text-rose-700 dark:text-rose-400",
                )}
                title="Closed state — drives reports + automations; can't be removed"
              >
                {r.terminal}
              </span>
            ) : (
              <button
                type="button"
                onClick={() =>
                  setRows((prev) => prev.filter((_, j) => j !== i))
                }
                disabled={disabled}
                className="shrink-0 text-muted-foreground hover:text-rose-600 disabled:opacity-30"
                title="Remove stage (you'll pick where its deals go)"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={disabled || rows.length >= MAX_STAGES_PER_PIPELINE}
        onClick={() =>
          setRows((prev) => {
            // Insert before the terminal stages.
            const firstTerminal = prev.findIndex((r) => r.terminal);
            const at = firstTerminal === -1 ? prev.length : firstTerminal;
            const next = [...prev];
            next.splice(at, 0, {
              id: null,
              label: "",
              tone: STAGE_TONES[(prev.length + 1) % STAGE_TONES.length].tone,
            });
            return next;
          })
        }
        className="mt-2 h-7 text-xs"
      >
        <Plus className="mr-1 h-3 w-3" />
        Add stage
      </Button>
    </>
  );
}

/** Migrate-prompt state after a 409 deals_in_removed_stages response. */
interface MigratePrompt {
  total: number;
  destinations: { id: string; label: string }[];
  chosen: string;
}

function PipelineEditor({
  pipeline,
  open,
  onToggle,
  canDelete,
}: {
  pipeline: ResolvedPipeline;
  open: boolean;
  onToggle: () => void;
  canDelete: boolean;
}) {
  const { subAccountId } = useSubAccount();
  const [name, setName] = useState(pipeline.name);
  const [rows, setRows] = useState<StageRow[]>(() =>
    rowsFromPipeline(pipeline),
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [migrate, setMigrate] = useState<MigratePrompt | null>(null);

  // Re-seed whenever the saved pipeline changes upstream.
  useEffect(() => {
    setName(pipeline.name);
    setRows(rowsFromPipeline(pipeline));
    setMigrate(null);
  }, [pipeline]);

  const dirty = useMemo(() => {
    if (name !== pipeline.name) return true;
    if (rows.length !== pipeline.stages.length) return true;
    return rows.some(
      (r, i) =>
        r.id !== pipeline.stages[i].id ||
        r.label !== pipeline.stages[i].label ||
        r.tone !== pipeline.stages[i].tone,
    );
  }, [name, rows, pipeline]);

  async function save(moveDealsTo?: string) {
    if (rows.some((r) => !r.label.trim())) {
      toast.error("Every stage needs a name.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/pipelines/${pipeline.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            stages: rows.map((r) => ({
              ...(r.id ? { id: r.id } : {}),
              label: r.label.trim(),
              tone: r.tone,
              ...(r.terminal ? { terminal: r.terminal } : {}),
            })),
            ...(moveDealsTo ? { moveDealsTo } : {}),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        code?: string;
        total?: number;
      };
      if (res.status === 409 && data.code === "deals_in_removed_stages") {
        // Destination must be one of the surviving stages.
        const destinations = rows
          .filter((r) => r.id) // only existing stages are valid targets
          .map((r) => ({ id: r.id as string, label: r.label }));
        setMigrate({
          total: data.total ?? 0,
          destinations,
          chosen: destinations[0]?.id ?? "",
        });
        return;
      }
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Couldn't save the pipeline.");
        return;
      }
      setMigrate(null);
      toast.success("Pipeline saved.");
    } catch {
      toast.error("Couldn't save the pipeline. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (
      !confirm(
        `Delete the "${pipeline.name}" pipeline? It must have no deals; this can't be undone.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/pipelines/${pipeline.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Couldn't delete the pipeline.");
        return;
      }
      toast.success("Pipeline deleted.");
    } catch {
      toast.error("Couldn't delete the pipeline.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="rounded-lg border bg-background">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 p-3 text-left"
      >
        <span className="flex-1 text-sm font-medium">
          {pipeline.name}
          {pipeline.id === DEFAULT_PIPELINE_ID && (
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Default
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">
          {pipeline.stages.length} stages
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-t p-3">
          <label className="mb-2 block text-xs font-medium">
            Pipeline name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={40}
              className="mt-1 h-8"
            />
          </label>
          <StageRowsEditor rows={rows} setRows={setRows} disabled={saving} />

          {migrate && (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
              <p className="mb-2">
                {migrate.total} deal{migrate.total === 1 ? "" : "s"} sit in the
                stage{migrate.total === 1 ? "" : "s"} you&apos;re removing.
                Where should they go?
              </p>
              <div className="flex items-center gap-2">
                <select
                  value={migrate.chosen}
                  onChange={(e) =>
                    setMigrate({ ...migrate, chosen: e.target.value })
                  }
                  className="h-8 flex-1 rounded-md border bg-background px-2 text-xs [&_option]:bg-background [&_option]:text-foreground"
                >
                  {migrate.destinations.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  disabled={saving || !migrate.chosen}
                  onClick={() => save(migrate.chosen)}
                >
                  Move deals &amp; save
                </Button>
              </div>
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => save()}
            >
              {saving ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Save pipeline
            </Button>
            {canDelete && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={deleting || saving}
                onClick={remove}
                className="text-rose-600 hover:text-rose-700"
              >
                {deleting ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 h-3.5 w-3.5" />
                )}
                Delete
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function NewPipelineEditor({ onDone }: { onDone: () => void }) {
  const { subAccountId } = useSubAccount();
  const [name, setName] = useState("");
  const [rows, setRows] = useState<StageRow[]>(() =>
    canonicalStageDefs().map((s) => ({
      id: null, // server mints fresh slugs for this pipeline
      label: s.label,
      tone: s.tone,
      terminal: s.terminal,
    })),
  );
  const [saving, setSaving] = useState(false);

  async function create() {
    if (!name.trim()) {
      toast.error("Give the pipeline a name.");
      return;
    }
    if (rows.some((r) => !r.label.trim())) {
      toast.error("Every stage needs a name.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/pipelines`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          stages: rows.map((r) => ({
            label: r.label.trim(),
            tone: r.tone,
            ...(r.terminal ? { terminal: r.terminal } : {}),
          })),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? "Couldn't create the pipeline.");
        return;
      }
      toast.success("Pipeline created.");
      onDone();
    } catch {
      toast.error("Couldn't create the pipeline.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed bg-background p-3">
      <label className="mb-2 block text-xs font-medium">
        New pipeline name
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder="e.g. Fulfillment"
          autoFocus
          className="mt-1 h-8"
        />
      </label>
      <StageRowsEditor rows={rows} setRows={setRows} disabled={saving} />
      <div className="mt-4 flex items-center gap-2">
        <Button type="button" size="sm" disabled={saving} onClick={create}>
          {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
          Create pipeline
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={saving}
          onClick={onDone}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

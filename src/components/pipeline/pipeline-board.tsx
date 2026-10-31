"use client";

import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  rectIntersection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";
import {
  type Deal,
  type PipelineStage,
  type PipelineStageId,
} from "@/types/deals";
import type { Contact } from "@/types/contacts";
import { GLOBAL_TERRITORY_ID, type TerritoryDoc } from "@/types";
import { lostStageId } from "@/lib/pipelines/resolve";
import type { ResolvedPipeline } from "@/types/pipelines";
import { DealCard } from "@/components/pipeline/deal-card";
import { EditDealDialog } from "@/components/pipeline/edit-deal-dialog";
import { LostReasonDialog } from "@/components/pipeline/lost-reason-dialog";
import { MoveStageSheet } from "@/components/pipeline/move-stage-sheet";

interface PipelineBoardProps {
  deals: Deal[];
  contacts: Contact[];
  territories: TerritoryDoc[];
  /** Supplies the stage columns; `deals` are already filtered to this pipeline. */
  pipeline: ResolvedPipeline;
}

/** Server route, so the stage webhooks fire. */
async function patchDealStage(
  dealId: string,
  stageId: PipelineStageId,
  lostReason?: string,
): Promise<void> {
  const res = await fetch(`/api/deals/${dealId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      lostReason !== undefined ? { stageId, lostReason } : { stageId },
    ),
  });
  if (!res.ok) throw new Error("move failed");
}

/** Falls back to "Global". */
function territoryName(
  id: string | null | undefined,
  byId: Map<string, string>,
): string | undefined {
  if (!id) return undefined;
  return byId.get(id) ?? (id === GLOBAL_TERRITORY_ID ? "Global" : undefined);
}

/** Column accent by tone family. Literal strings only so Tailwind's content scan picks them up. */
const ACCENT_BY_COLOR: Record<string, string> = {
  slate: "from-slate-400 to-slate-500",
  blue: "from-blue-400 to-blue-500",
  indigo: "from-indigo-400 to-indigo-500",
  violet: "from-violet-400 to-violet-500",
  fuchsia: "from-fuchsia-400 to-fuchsia-500",
  amber: "from-amber-400 to-amber-500",
  orange: "from-orange-400 to-orange-500",
  teal: "from-teal-400 to-teal-500",
  cyan: "from-cyan-400 to-cyan-500",
  emerald: "from-emerald-400 to-emerald-500",
  rose: "from-rose-400 to-rose-500",
};

function stageAccent(stage: PipelineStage): string {
  const color = /bg-([a-z]+)-/.exec(stage.tone)?.[1] ?? "slate";
  return ACCENT_BY_COLOR[color] ?? ACCENT_BY_COLOR.slate;
}

export function PipelineBoard({
  deals,
  contacts,
  territories,
  pipeline,
}: PipelineBoardProps) {
  const contactById = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const c of contacts) map.set(c.id, c);
    return map;
  }, [contacts]);

  const territoryNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of territories) map.set(t.id, t.name);
    return map;
  }, [territories]);

  const stages = pipeline.stages;
  const lostId = lostStageId(pipeline);

  const dealsByStage = useMemo(() => {
    const grouped = new Map<PipelineStageId, Deal[]>();
    for (const s of stages) grouped.set(s.id, []);
    const firstStageId = stages[0]?.id;
    for (const d of deals) {
      const stage = grouped.get(d.stageId as PipelineStageId);
      if (stage) stage.push(d);
      // Deal in a since-removed stage: park it in column 1.
      else if (firstStageId) grouped.get(firstStageId)?.push(d);
    }
    return grouped;
  }, [deals, stages]);

  const [activeDeal, setActiveDeal] = useState<Deal | null>(null);
  const [pendingLost, setPendingLost] = useState<Deal | null>(null);
  const [editingDealId, setEditingDealId] = useState<string | null>(null);
  const editingDeal =
    deals.find((d) => d.id === editingDealId) ?? null;
  // Mobile tap-to-move sheet.
  const [movingDealId, setMovingDealId] = useState<string | null>(null);
  const movingDeal = deals.find((d) => d.id === movingDealId) ?? null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragStart(e: DragStartEvent) {
    const deal = deals.find((d) => d.id === e.active.id);
    setActiveDeal(deal ?? null);
  }

  async function handleDragEnd(e: DragEndEvent) {
    setActiveDeal(null);
    const overId = e.over?.id;
    if (!overId) return;
    const deal = deals.find((d) => d.id === e.active.id);
    if (!deal) return;
    const nextStageId = String(overId) as PipelineStageId;
    if (!stages.some((s) => s.id === nextStageId)) return;
    if (nextStageId === deal.stageId) return;

    if (nextStageId === lostId) {
      setPendingLost(deal);
      return;
    }

    try {
      await patchDealStage(deal.id, nextStageId);
      const label = stages.find((s) => s.id === nextStageId)?.label;
      toast.success(`Moved to ${label}`);
    } catch (err) {
      console.error(err);
      toast.error("Couldn't move deal. Try again.");
    }
  }

  async function confirmLost(reason: string) {
    if (!pendingLost) return;
    try {
      await patchDealStage(pendingLost.id, lostId, reason);
      toast.success(
        `Moved to ${stages.find((s) => s.id === lostId)?.label ?? "Lost"}`,
      );
    } catch (err) {
      console.error(err);
      toast.error("Couldn't move deal. Try again.");
    } finally {
      setPendingLost(null);
    }
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={rectIntersection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveDeal(null)}
      >
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stages.map((stage) => (
            <Column
              key={stage.id}
              stage={stage}
              deals={dealsByStage.get(stage.id) ?? []}
              contactById={contactById}
              territoryNameById={territoryNameById}
              activeId={activeDeal?.id}
              onEditDeal={(id) => setEditingDealId(id)}
              onMoveDeal={(id) => setMovingDealId(id)}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeDeal ? (
            <DealCard
              deal={activeDeal}
              contact={contactById.get(activeDeal.contactId)}
              territoryName={territoryName(
                activeDeal.territoryId,
                territoryNameById,
              )}
              overlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      <MoveStageSheet
        deal={movingDeal}
        stages={stages}
        onClose={() => setMovingDealId(null)}
        onMove={async (stageId) => {
          if (!movingDeal) return;
          setMovingDealId(null);
          if (stageId === lostId) {
            // Same lost-reason gate the drag path goes through.
            setPendingLost(movingDeal);
            return;
          }
          try {
            await patchDealStage(movingDeal.id, stageId);
            toast.success(
              `Moved to ${stages.find((s) => s.id === stageId)?.label}`,
            );
          } catch (err) {
            console.error(err);
            toast.error("Couldn't move deal. Try again.");
          }
        }}
      />

      <LostReasonDialog
        open={!!pendingLost}
        dealTitle={pendingLost?.title}
        onCancel={() => setPendingLost(null)}
        onConfirm={confirmLost}
      />

      <EditDealDialog
        deal={editingDeal}
        open={!!editingDeal}
        onOpenChange={(o) => !o && setEditingDealId(null)}
        contacts={contacts}
        territories={territories}
      />
    </>
  );
}

function Column({
  stage,
  deals,
  contactById,
  territoryNameById,
  activeId,
  onEditDeal,
  onMoveDeal,
}: {
  stage: PipelineStage;
  deals: Deal[];
  contactById: Map<string, Contact>;
  territoryNameById: Map<string, string>;
  activeId?: string;
  onEditDeal: (id: string) => void;
  onMoveDeal: (id: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const total = deals.reduce((sum, d) => sum + (d.value || 0), 0);
  const currency = deals[0]?.currency ?? "USD";
  const accent = stageAccent(stage);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-w-[220px] flex-1 basis-0 flex-col overflow-hidden rounded-xl border bg-muted/20 transition-colors",
        isOver && "border-primary/60 bg-primary/5 ring-2 ring-primary/20",
      )}
    >
      <div
        className={cn("h-1 w-full bg-gradient-to-r", accent)}
        aria-hidden
      />
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", stage.tone)}>
            {stage.label}
          </span>
          <span className="text-xs font-medium tabular-nums text-muted-foreground">
            {deals.length}
          </span>
        </div>
        {total > 0 && (
          <span className="truncate text-[11px] font-medium tabular-nums text-muted-foreground">
            {formatCurrency(total, currency)}
          </span>
        )}
      </div>

      <div className="flex-1 space-y-2 p-2 pt-1">
        {deals.length === 0 ? (
          <EmptyCol />
        ) : (
          deals.map((deal) => (
            <DraggableDeal
              key={deal.id}
              deal={deal}
              contact={contactById.get(deal.contactId)}
              territoryName={territoryName(deal.territoryId, territoryNameById)}
              dragging={activeId === deal.id}
              onEdit={() => onEditDeal(deal.id)}
              onMoveRequest={() => onMoveDeal(deal.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DraggableDeal({
  deal,
  contact,
  territoryName,
  dragging,
  onEdit,
  onMoveRequest,
}: {
  deal: Deal;
  contact: Contact | undefined;
  territoryName?: string;
  dragging: boolean;
  onEdit: () => void;
  onMoveRequest: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: deal.id,
  });
  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;
  return (
    <DealCard
      deal={deal}
      contact={contact}
      territoryName={territoryName}
      dragging={dragging}
      setNodeRef={setNodeRef}
      style={style}
      listeners={listeners as unknown as React.HTMLAttributes<HTMLElement>}
      attributes={attributes as unknown as React.HTMLAttributes<HTMLElement>}
      onEdit={onEdit}
      onMoveRequest={onMoveRequest}
    />
  );
}

function EmptyCol() {
  return (
    <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-center text-[11px] text-muted-foreground/60">
      Drop deals here
    </div>
  );
}

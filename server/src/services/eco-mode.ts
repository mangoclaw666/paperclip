// fork_mangoclaw: eco-mode — has-changes gate for heartbeat timer wakes.
// Idle agents (e.g. inbox=0) waste LLM cost every cycle just to print
// "no work". This module is the cheap pre-check: SQL-only diff against a
// snapshot timestamp; LLM is only spawned when something actually changed.
//
// Mirrors the brain.py-era `has_changes()` pattern (file mtime + counts)
// translated to PaperClip's DB schema (issues / issue_comments / wakeup_requests).
//
// Gate location: see heartbeat.ts `enqueueWakeup` timer branch.

import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  issueComments,
  issues,
} from "@paperclipai/db";

const ECO_SNAPSHOT_VERSION = 1;
const ECO_DEFAULT_MAX_IDLE_HOURS = 6;

export interface EcoSnapshot {
  readonly version: number;
  /** ISO timestamp — "we have observed everything up to this point". */
  readonly checkedAt: string;
}

export interface EcoCheckResult {
  readonly hasChanges: boolean;
  /** Short machine-readable reason. Surfaces as `eco.no_changes:<reason>` or
   *  `eco.wake:<reason>` in skipped/queued wakeup rows for ops visibility. */
  readonly reason: string;
  /** Snapshot to persist if a wake is enqueued. */
  readonly nextSnapshot: EcoSnapshot;
}

export interface EcoCheckOptions {
  readonly maxIdleHours?: number;
  /** Override "now" for tests. */
  readonly now?: Date;
}

// ---------------------------------------------------------------------------
// Snapshot codec — stored under agentRuntimeState.stateJson.lastEcoSnapshot
// ---------------------------------------------------------------------------

export function loadEcoSnapshot(stateJson: unknown): EcoSnapshot | null {
  if (!stateJson || typeof stateJson !== "object") return null;
  const wrap = (stateJson as Record<string, unknown>).lastEcoSnapshot;
  if (!wrap || typeof wrap !== "object") return null;
  const w = wrap as Record<string, unknown>;
  const checkedAt = typeof w.checkedAt === "string" ? w.checkedAt : null;
  if (!checkedAt) return null;
  const version = typeof w.version === "number" ? w.version : ECO_SNAPSHOT_VERSION;
  return { version, checkedAt };
}

export function buildEcoSnapshot(now: Date = new Date()): EcoSnapshot {
  return { version: ECO_SNAPSHOT_VERSION, checkedAt: now.toISOString() };
}

/** Merge `lastEcoSnapshot` into stateJson without clobbering other keys. */
export async function saveEcoSnapshot(
  db: Db,
  agentId: string,
  snapshot: EcoSnapshot,
): Promise<void> {
  // jsonb concat (||) is a merge at the top level — replaces lastEcoSnapshot only.
  await db
    .update(agentRuntimeState)
    .set({
      stateJson: sql`coalesce(${agentRuntimeState.stateJson}, '{}'::jsonb) || ${JSON.stringify({ lastEcoSnapshot: snapshot })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(agentRuntimeState.agentId, agentId));
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export async function detectChangesForEcoMode(
  db: Db,
  agent: typeof agents.$inferSelect,
  lastSnapshot: EcoSnapshot | null,
  opts: EcoCheckOptions = {},
): Promise<EcoCheckResult> {
  const now = opts.now ?? new Date();
  const maxIdleHours = Math.max(0, opts.maxIdleHours ?? ECO_DEFAULT_MAX_IDLE_HOURS);

  // First wake — no prior snapshot, always proceed (safe default).
  if (!lastSnapshot) {
    return { hasChanges: true, reason: "first_wake", nextSnapshot: buildEcoSnapshot(now) };
  }

  const checkedAt = new Date(lastSnapshot.checkedAt);
  if (Number.isNaN(checkedAt.getTime())) {
    return { hasChanges: true, reason: "snapshot_invalid", nextSnapshot: buildEcoSnapshot(now) };
  }

  // Max-idle safety valve — even if nothing changed, an agent shouldn't
  // sleep forever. Director's autonomous KR/objective cascade needs this.
  if (maxIdleHours > 0) {
    const idleMs = now.getTime() - checkedAt.getTime();
    if (idleMs > maxIdleHours * 3600 * 1000) {
      return { hasChanges: true, reason: "max_idle_exceeded", nextSnapshot: buildEcoSnapshot(now) };
    }
  }

  // Signal 1 — any issue assigned to this agent has been modified
  // (status change / new assignment / edit / description update).
  const issueChange = await db
    .select({ exists: sql<number>`1` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, agent.companyId),
        eq(issues.assigneeAgentId, agent.id),
        gt(issues.updatedAt, checkedAt),
      ),
    )
    .limit(1);
  if (issueChange.length > 0) {
    return { hasChanges: true, reason: "issue_changed", nextSnapshot: buildEcoSnapshot(now) };
  }

  // Signal 2 — any new comment on an issue assigned to this agent
  // (board mentions, peer agent replies, automation comments).
  const commentChange = await db
    .select({ exists: sql<number>`1` })
    .from(issueComments)
    .innerJoin(issues, eq(issueComments.issueId, issues.id))
    .where(
      and(
        eq(issues.companyId, agent.companyId),
        eq(issues.assigneeAgentId, agent.id),
        gt(issueComments.createdAt, checkedAt),
      ),
    )
    .limit(1);
  if (commentChange.length > 0) {
    return { hasChanges: true, reason: "new_comment", nextSnapshot: buildEcoSnapshot(now) };
  }

  // Signal 3 — any non-timer wakeup request for this agent since last check.
  // (timer source is excluded because that's *this* check itself; assignment /
  // on_demand / automation / mention sources indicate external trigger.)
  const wakeupChange = await db
    .select({ exists: sql<number>`1` })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.agentId, agent.id),
        gt(agentWakeupRequests.requestedAt, checkedAt),
        ne(agentWakeupRequests.source, "timer"),
      ),
    )
    .limit(1);
  if (wakeupChange.length > 0) {
    return { hasChanges: true, reason: "external_wakeup", nextSnapshot: buildEcoSnapshot(now) };
  }

  // Nothing to do — skip the LLM spawn.
  return {
    hasChanges: false,
    reason: "no_signals",
    // nextSnapshot is unused on skip but returned for type completeness.
    nextSnapshot: lastSnapshot,
  };
}

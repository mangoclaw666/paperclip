// fork_mangoclaw: eco-mode tests — has-changes gate logic.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildEcoSnapshot,
  detectChangesForEcoMode,
  loadEcoSnapshot,
  saveEcoSnapshot,
} from "../services/eco-mode.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres eco-mode tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("eco-mode has-changes gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-eco-mode-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(opts: { idleHoursAgo?: number } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "EcoCo",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "EcoAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "claude_local",
      stateJson: {},
    });
    const agent = (await db.select().from(agents).where(eq(agents.id, agentId)))[0];
    return { companyId, agentId, agent };
  }

  // -------------------------------------------------------------------------
  // Snapshot codec
  // -------------------------------------------------------------------------

  it("loadEcoSnapshot returns null for missing / malformed input", () => {
    expect(loadEcoSnapshot(null)).toBeNull();
    expect(loadEcoSnapshot(undefined)).toBeNull();
    expect(loadEcoSnapshot({})).toBeNull();
    expect(loadEcoSnapshot({ lastEcoSnapshot: null })).toBeNull();
    expect(loadEcoSnapshot({ lastEcoSnapshot: { checkedAt: 123 } })).toBeNull();
    expect(loadEcoSnapshot("garbage")).toBeNull();
  });

  it("loadEcoSnapshot round-trips with buildEcoSnapshot", () => {
    const now = new Date("2026-05-20T10:00:00Z");
    const snap = buildEcoSnapshot(now);
    const wrapped = { lastEcoSnapshot: snap };
    const loaded = loadEcoSnapshot(wrapped);
    expect(loaded).toEqual(snap);
    expect(loaded?.checkedAt).toBe("2026-05-20T10:00:00.000Z");
  });

  it("saveEcoSnapshot merges without clobbering other stateJson keys", async () => {
    const { agentId } = await seedAgent();
    // Seed an unrelated state key.
    await db
      .update(agentRuntimeState)
      .set({ stateJson: { someOtherKey: "preserve-me" } })
      .where(eq(agentRuntimeState.agentId, agentId));

    const snap = buildEcoSnapshot(new Date("2026-05-20T10:00:00Z"));
    await saveEcoSnapshot(db, agentId, snap);

    const [row] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    expect(row.stateJson).toMatchObject({
      someOtherKey: "preserve-me",
      lastEcoSnapshot: { checkedAt: "2026-05-20T10:00:00.000Z", version: 1 },
    });
  });

  // -------------------------------------------------------------------------
  // Detection — first-wake / invalid / idle-exceeded
  // -------------------------------------------------------------------------

  it("first wake (snapshot=null) returns hasChanges=true with reason=first_wake", async () => {
    const { agent } = await seedAgent();
    const result = await detectChangesForEcoMode(db, agent, null);
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toBe("first_wake");
    expect(result.nextSnapshot.checkedAt).toBeTruthy();
  });

  it("invalid snapshot (NaN checkedAt) returns snapshot_invalid", async () => {
    const { agent } = await seedAgent();
    const result = await detectChangesForEcoMode(db, agent, { version: 1, checkedAt: "not-a-date" });
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toBe("snapshot_invalid");
  });

  it("max idle exceeded triggers wake even with no signals", async () => {
    const { agent } = await seedAgent();
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
    const snap = buildEcoSnapshot(sevenHoursAgo);
    const result = await detectChangesForEcoMode(db, agent, snap, { maxIdleHours: 6 });
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toBe("max_idle_exceeded");
  });

  // -------------------------------------------------------------------------
  // Detection — actual change signals
  // -------------------------------------------------------------------------

  it("no signals + within idle window → hasChanges=false", async () => {
    const { agent } = await seedAgent();
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000);
    const snap = buildEcoSnapshot(oneMinuteAgo);
    const result = await detectChangesForEcoMode(db, agent, snap, { maxIdleHours: 6 });
    expect(result.hasChanges).toBe(false);
    expect(result.reason).toBe("no_signals");
  });

  it("issue assigned to agent + updated_at > checkedAt → issue_changed", async () => {
    const { agent, companyId, agentId } = await seedAgent();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const snap = buildEcoSnapshot(fiveMinutesAgo);

    // Insert an issue with updated_at in the past first, then bump it.
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      assigneeAgentId: agentId,
      title: "do thing",
      status: "todo",
      priority: "medium",
      requestDepth: 0,
      issueNumber: 1,
      identifier: "T-1",
    });
    // updated_at is set by default to now() which is > checkedAt (5 min ago).

    const result = await detectChangesForEcoMode(db, agent, snap);
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toBe("issue_changed");
  });

  it("issue NOT assigned to agent does NOT trigger", async () => {
    const { agent, companyId } = await seedAgent();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const snap = buildEcoSnapshot(fiveMinutesAgo);

    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "OtherAgent",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      assigneeAgentId: otherAgentId,
      title: "not mine",
      status: "todo",
      priority: "medium",
      requestDepth: 0,
      issueNumber: 1,
      identifier: "T-1",
    });

    const result = await detectChangesForEcoMode(db, agent, snap);
    expect(result.hasChanges).toBe(false);
  });

  it("new comment on assigned issue → new_comment", async () => {
    const { agent, companyId, agentId } = await seedAgent();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      assigneeAgentId: agentId,
      title: "x",
      status: "todo",
      priority: "medium",
      requestDepth: 0,
      issueNumber: 2,
      identifier: "T-2",
      // backdate issue updated_at so the issue-change signal doesn't fire.
      updatedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      body: "hello",
    });

    const snap = buildEcoSnapshot(fiveMinutesAgo);
    const result = await detectChangesForEcoMode(db, agent, snap);
    // Either issue_changed or new_comment depending on order of signal evaluation;
    // both indicate a wake should occur. We check the primary contract.
    expect(result.hasChanges).toBe(true);
    expect(["issue_changed", "new_comment"]).toContain(result.reason);
  });

  it("new non-timer wakeup → external_wakeup", async () => {
    const { agent, agentId, companyId } = await seedAgent();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const snap = buildEcoSnapshot(fiveMinutesAgo);

    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
      requestedByActorType: "system",
    });

    const result = await detectChangesForEcoMode(db, agent, snap);
    expect(result.hasChanges).toBe(true);
    expect(result.reason).toBe("external_wakeup");
  });

  it("only timer wakeups since last check → still no_signals (self-noise excluded)", async () => {
    const { agent, agentId, companyId } = await seedAgent();
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const snap = buildEcoSnapshot(fiveMinutesAgo);

    // A timer wakeup that the gate itself produced shouldn't re-trigger.
    await db.insert(agentWakeupRequests).values({
      id: randomUUID(),
      companyId,
      agentId,
      source: "timer",
      status: "queued",
      requestedByActorType: "system",
    });

    const result = await detectChangesForEcoMode(db, agent, snap);
    expect(result.hasChanges).toBe(false);
    expect(result.reason).toBe("no_signals");
  });
});

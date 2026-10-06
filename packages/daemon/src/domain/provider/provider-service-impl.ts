// Slice-04 (OPR.0.5.0.4) C1 (resume) — the production ProviderService. getReadModel is fully
// wired over the collection seam (real codex-auth reader + node-inventory across rigs + clock).
// precheck composes the pure precheckSwitch gate (fails closed on unknown auth per BR-3). switch
// validates the saved profile at use, atomically activates it, updates the seat binding metadata,
// and writes request/completion events around the mutation.

import type Database from "better-sqlite3";
import {
  AGENT_ACTIVITY_FRESHNESS_MS,
  type AgentActivityStore,
} from "../agent-activity-store.js";
import { getNodeInventory } from "../node-inventory.js";
import { readCodexAuthMetadata, type CodexAuthMetadata } from "./codex-auth-reader.js";
import { collectFourBlockReadModel, type ProviderSeat } from "./provider-collect.js";
import { precheckSwitch } from "./provider-policy.js";
import { collectReactiveEventSignals } from "./reactive-tap.js";
import { createCodexProfileStore, type CodexProfileStore } from "./codex-profile-store.js";
import type { EventBus } from "../event-bus.js";
import type {
  ProviderService,
  ProviderPrecheckInput,
  ProviderSwitchInput,
  ProviderSwitchResult,
} from "./provider-service.js";
import type { FourBlockReadModel, PrecheckResult, ProviderSignal } from "./provider-types.js";

export interface ProviderServiceImplDeps {
  db: Database.Database;
  /** The rig universe (rigRepo.listRigs()) — each rig's node-inventory contributes seats. */
  listRigs: () => Array<{ id: string }>;
  /** Slice-04 C3: the Claude statusline provider_usage signal source (undefined → signals []). */
  collectClaudeSignals?: () => ProviderSignal[];
  /** Slice-04 C4: the shipped structured activity detector. Undefined keeps the reactive lane empty. */
  agentActivityStore?: Pick<AgentActivityStore, "getLatestForNode">;
  authProfileStore?: CodexProfileStore;
  eventBus?: Pick<EventBus, "emit">;
  /** W2a tap: operator-visible disposition sink. Observability only; never a verification producer. */
  warn?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class ProviderServiceImpl implements ProviderService {
  constructor(private readonly deps: ProviderServiceImplDeps) {}

  async getReadModel(): Promise<FourBlockReadModel> {
    const env = this.deps.env ?? process.env;
    const asOf = (this.deps.now ?? (() => new Date().toISOString()))();
    let auth: CodexAuthMetadata | undefined;
    let seats: ProviderSeat[] | undefined;
    const readAuth = () => auth ??= readCodexAuthMetadata(env);
    const listSeats = () => seats ??= this.listSeats();
    const collectReactiveSignals = (): ProviderSignal[] => {
      if (!this.deps.agentActivityStore) return [];
      const result = collectReactiveEventSignals({
        seats: listSeats(),
        auth: readAuth(),
        activity: this.deps.agentActivityStore,
        now: asOf,
        freshnessMs: AGENT_ACTIVITY_FRESHNESS_MS,
      });
      const warn = this.deps.warn ?? ((message: string) => console.warn(message));
      for (const disposition of [...result.triggers, ...result.discards]) {
        warn(`[provider-reactive-tap] ${JSON.stringify(disposition)}`);
      }
      return result.signals;
    };
    return collectFourBlockReadModel({
      readCodexAuth: readAuth,
      listSeats,
      collectSignals: () => [
        ...(this.deps.collectClaudeSignals?.() ?? []),
        ...collectReactiveSignals(),
      ],
      now: () => asOf,
    });
  }

  private listSeats(): Array<ProviderSeat & { nodeId: string; rigId: string; cwd: string }> {
    const seats: Array<ProviderSeat & { nodeId: string; rigId: string; cwd: string }> = [];
    for (const rig of this.deps.listRigs()) {
      for (const entry of getNodeInventory(this.deps.db, rig.id)) {
        if (!entry.canonicalSessionName) continue;
        seats.push({
          nodeId: entry.nodeId,
          rigId: entry.rigId,
          seatSession: entry.canonicalSessionName,
          rigName: entry.rigName ?? "",
          cwd: entry.cwd ?? "unknown",
          runtime: entry.runtime ?? "unknown",
          lifecycleState: entry.lifecycleState,
        });
      }
    }
    return seats;
  }

  async precheck(input: ProviderPrecheckInput): Promise<PrecheckResult> {
    const seat = this.listSeats().find((candidate) => candidate.seatSession === input.seat);
    if (!seat) return { safe: false, reasons: ["seat_not_found"] };
    const store = this.deps.authProfileStore ?? createCodexProfileStore(this.deps.env ?? process.env);
    const activity = this.deps.agentActivityStore?.getLatestForNode({
      sessionName: seat.seatSession,
      now: new Date((this.deps.now ?? (() => new Date().toISOString()))()),
    });
    const interruptedAtLimit = activity?.stale !== true
      && activity?.generationProvenance === "resolved"
      && ["at_limit", "rate_limit", "rate_limited"].includes(activity.rawEvent ?? "");
    // A non-running seat has no live conversation. For a running seat, a fresh, generation-resolved
    // idle hook is positive evidence of safety. A typed at-limit interruption is also releasable: the
    // provider has already stopped the turn, and the caller must hand it over when rebind is pending.
    const seatHasLiveConversation = seat.lifecycleState === "running"
      && !interruptedAtLimit
      && !(activity?.state === "idle" && activity.stale !== true && activity.generationProvenance !== "unresolved");
    return precheckSwitch({
      targetProvider: seat.runtime === "codex" ? "codex" : "claude",
      targetAuthState: store.inspect(input.toAccount),
      seatHasLiveConversation,
    });
  }

  async switchAccount(input: ProviderSwitchInput): Promise<ProviderSwitchResult> {
    // Precheck-gate: never switch past an unsafe verdict unless explicitly forced.
    const verdict = await this.precheck({ seat: input.seat, toAccount: input.toAccount });
    // `--force-unsafe` may override auth uncertainty, but never the stranding guard.
    if (verdict.safe === false && (!input.forceUnsafe || verdict.reasons.includes("would_strand_live_conversation"))) {
      const reasons = verdict.reasons.length > 0 ? verdict.reasons : ["precheck_unsafe"];
      return { outcome: "failed_safely", reasons: reasons as [string, ...string[]] };
    }
    const seat = this.listSeats().find((candidate) => candidate.seatSession === input.seat);
    if (!seat) return { outcome: "failed_safely", reasons: ["seat_not_found"] };
    const now = (this.deps.now ?? (() => new Date().toISOString()))();
    if (!this.deps.eventBus) {
      return { outcome: "failed_safely", reasons: ["switch_action_record_unavailable"] };
    }
    try {
      this.deps.eventBus.emit({
        type: "provider.account_switch_requested",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        seat: seat.seatSession,
        toAccount: input.toAccount,
        requestedAt: now,
      });
    } catch {
      return { outcome: "failed_safely", reasons: ["switch_action_record_failed"] };
    }
    const store = this.deps.authProfileStore ?? createCodexProfileStore(this.deps.env ?? process.env);
    const switched = store.switchAndBind({
      name: input.toAccount,
      seat: seat.seatSession,
      rig: seat.rigName,
      cwd: seat.cwd,
      switchedAt: now,
    });
    if (!switched.ok) {
      try {
        this.deps.eventBus.emit({
          type: "provider.account_switch_failed",
          rigId: seat.rigId,
          nodeId: seat.nodeId,
          seat: seat.seatSession,
          toAccount: input.toAccount,
          failedAt: now,
          reason: switched.reason,
        });
      } catch { /* the durable request event still records the attempted action */ }
      return { outcome: "failed_safely", reasons: [switched.reason] };
    }
    try {
      this.deps.eventBus.emit({
        type: "provider.account_switch_completed",
        rigId: seat.rigId,
        nodeId: seat.nodeId,
        seat: seat.seatSession,
        toAccount: input.toAccount,
        completedAt: now,
        effect: "future_launches_only",
      });
    } catch {
      // The requested event is already durable. The auth switch is not rolled back after a completed
      // atomic publish; report the true operational state instead of claiming no switch happened.
    }
    return seat.lifecycleState === "running" ? { outcome: "rebind_in_progress" } : { outcome: "succeeded" };
  }
}

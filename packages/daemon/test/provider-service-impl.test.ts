// Slice-04 (OPR.0.5.0.4) C1 — production ProviderService wiring pins (getReadModel over injected
// deps; precheck fail-closed on unknown auth per BR-3; switch is audited and fail-closed).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";

const ASOF = "2026-08-04T00:00:00.000Z";

function emptyCodexHomeEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-impl-codex-"));
  return { CODEX_HOME: home } as NodeJS.ProcessEnv;
}

function makeSvc() {
  return new ProviderServiceImpl({
    db: createFullTestDb(),
    listRigs: () => [], // no rigs → no seats; getReadModel never touches getNodeInventory
    env: emptyCodexHomeEnv(),
    now: () => ASOF,
  });
}

function switchableSvc(overrides: Partial<ConstructorParameters<typeof ProviderServiceImpl>[0]> = {}) {
  const db = createFullTestDb();
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, 'codex', ?)")
    .run("node-1", "rig-1", "dev", "/work");
  db.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, 'exited', 'ready')")
    .run("session-1", "node-1", "dev@test-rig");
  db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)")
    .run("binding-1", "node-1", "dev@test-rig");
  return new ProviderServiceImpl({
    db,
    listRigs: () => [{ id: "rig-1" }],
    now: () => ASOF,
    authProfileStore: {
      inspect: () => "active",
      switchAndBind: () => ({ ok: true }),
    },
    eventBus: { emit: () => ({}) as never },
    ...overrides,
  });
}

describe("ProviderServiceImpl — production getReadModel/precheck/switch wiring", () => {
  it("getReadModel over an empty codex home + no rigs is a well-formed empty four-block", async () => {
    const model = await makeSvc().getReadModel();
    // S-A amendment (OPR.0.5.0.4 A2, README 21a5cb73): the read model additively carries the
    // host-level usage rollup — empty here (no providers present ⇒ no rows, honestly).
    expect(model).toEqual({ accounts: [], bindings: [], signals: [], hostUsage: [], asOf: ASOF });
  });

  it("precheck for an absent seat fails CLOSED, never safe", async () => {
    const r = await makeSvc().precheck({ seat: "dev-driver@rig", toAccount: "no-such-account" });
    expect(r.safe).toBe(false);
    if (r.safe === false) expect(r.reasons).toContain("seat_not_found");
  });

  it("switchAccount precheck-gates to failed_safely (never fabricates succeeded)", async () => {
    const r = await makeSvc().switchAccount({ seat: "dev-driver@rig", toAccount: "no-such-account", forceUnsafe: false });
    expect(r.outcome).toBe("failed_safely");
    if (r.outcome === "failed_safely") expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("switchAccount with forceUnsafe still refuses an absent seat", async () => {
    const r = await makeSvc().switchAccount({ seat: "dev-driver@rig", toAccount: "no-such-account", forceUnsafe: true });
    expect(r.outcome).toBe("failed_safely");
    if (r.outcome === "failed_safely") expect(r.reasons).toContain("seat_not_found");
  });

  it("switches and binds a stopped Codex seat", async () => {
    const switched: unknown[] = [];
    const svc = switchableSvc({ authProfileStore: {
      inspect: () => "active",
      switchAndBind: (input) => { switched.push(input); return { ok: true }; },
    } });
    const seat = (await svc.getReadModel()).bindings[0]?.seatSession;
    expect(seat).toBeTruthy();
    const result = await svc.switchAccount({ seat: seat!, toAccount: "enterprise", forceUnsafe: false });
    expect(result).toEqual({ outcome: "succeeded" });
    expect(switched).toHaveLength(1);
  });

  it("getReadModel surfaces Claude statusline signals from the collectClaudeSignals dep (C3 wiring)", async () => {
    const sig = { provider: "claude" as const, accountRef: "sub", sourceClass: "unknown" as const, authority: "unknown" as const, asOf: ASOF, unknownReason: "claude_no_statusline_cache_yet", automationUse: "do_not_automate" as const };
    const svc = new ProviderServiceImpl({ db: createFullTestDb(), listRigs: () => [], env: emptyCodexHomeEnv(), now: () => ASOF, collectClaudeSignals: () => [sig] });
    const model = await svc.getReadModel();
    expect(model.signals).toEqual([sig]);
  });
});

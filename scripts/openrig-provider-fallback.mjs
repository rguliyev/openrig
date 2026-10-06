#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const config = {
  daemonUrl: process.env.OPENRIG_DAEMON_URL ?? "http://127.0.0.1:7433",
  primary: process.env.OPENRIG_PRIMARY_ACCOUNT ?? "pro",
  fallback: process.env.OPENRIG_FALLBACK_ACCOUNT ?? "enterprise",
  seat: process.env.OPENRIG_FALLBACK_SEAT?.trim() || null,
  pollMs: Number(process.env.OPENRIG_FALLBACK_POLL_MS ?? 15_000),
  rigBin: process.env.OPENRIG_RIG_BIN ?? "rig",
  stateFile: process.env.OPENRIG_FALLBACK_STATE
    ?? path.join(process.env.OPENRIG_HOME ?? path.join(process.env.HOME ?? "", ".openrig"), "provider-fallback-state.json"),
  once: process.argv.includes("--once"),
  apply: process.argv.includes("--apply"),
};

function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
}

async function request(apiPath, init) {
  const response = await fetch(`${config.daemonUrl}${apiPath}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function fresh(signal, now = Date.now()) {
  const staleAt = Date.parse(signal.staleAfter ?? "");
  return Number.isFinite(staleAt) && now < staleAt;
}

function selectTrigger(model) {
  const signals = (model.signals ?? []).filter((signal) =>
    signal.provider === "codex"
    && signal.accountRef === config.primary
    && signal.sourceClass === "provider_event"
    && signal.authority === "reactive_error"
    && signal.automationUse === "allow_switch_decision"
    && fresh(signal));
  const seats = [...new Set(signals.map((signal) => signal.seatSession).filter(Boolean))];
  if (config.seat) return signals.some((signal) => signal.seatSession === config.seat) ? config.seat : null;
  if (seats.length !== 1) {
    if (seats.length > 1) log("refused_ambiguous_trigger", { seats });
    return null;
  }
  return seats[0];
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ ok: false, code: null, stdout, stderr: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

function writeState(state) {
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true, mode: 0o700 });
  const tmp = `${config.stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, config.stateFile);
}

async function tick() {
  const model = await request("/api/provider/status");
  const seat = selectTrigger(model);
  if (!seat) return;
  const binding = (model.bindings ?? []).find((row) => row.seatSession === seat);
  if (!binding || binding.accountId !== config.primary) {
    log("refused_binding_mismatch", { seat, expected: config.primary, actual: binding?.accountId ?? null });
    return;
  }
  const otherBoundSeats = (model.bindings ?? []).filter((row) => row.accountId !== null && row.seatSession !== seat);
  if (otherBoundSeats.length > 0) {
    log("refused_global_auth_scope", { seat, otherSeats: otherBoundSeats.map((row) => row.seatSession) });
    return;
  }
  const precheck = await request(`/api/provider/precheck?${new URLSearchParams({ seat, toAccount: config.fallback })}`);
  if (!precheck.safe) {
    log("precheck_refused", { seat, reasons: precheck.reasons ?? [] });
    return;
  }
  if (!config.apply) {
    log("dry_run_would_switch", { seat, from: config.primary, to: config.fallback });
    return;
  }
  const switched = await request("/api/provider/switch", {
    method: "POST",
    body: JSON.stringify({ seat, toAccount: config.fallback, forceUnsafe: false }),
  });
  if (switched.outcome === "failed_safely") {
    log("switch_failed", { seat, reasons: switched.reasons ?? [] });
    return;
  }
  writeState({ state: "auth_switched", seat, from: config.primary, to: config.fallback, switchedAt: new Date().toISOString(), outcome: switched.outcome });
  log("auth_switched", { seat, outcome: switched.outcome });
  if (switched.outcome !== "rebind_in_progress") return;
  const handover = await run(config.rigBin, ["seat", "handover", seat, "--source", "fresh", "--reason", "provider-limit-fallback", "--operator", "openrig-provider-watcher", "--json"]);
  if (!handover.ok) {
    writeState({ state: "handover_failed", seat, from: config.primary, to: config.fallback, failedAt: new Date().toISOString(), code: handover.code });
    log("handover_failed", { seat, code: handover.code, stderr: handover.stderr.trim().slice(0, 500) });
    return;
  }
  writeState({ state: "complete", seat, from: config.primary, to: config.fallback, completedAt: new Date().toISOString() });
  log("fallback_complete", { seat });
  process.exit(0);
}

if (!Number.isFinite(config.pollMs) || config.pollMs < 1_000) throw new Error("OPENRIG_FALLBACK_POLL_MS must be at least 1000");
log("watcher_started", { apply: config.apply, primary: config.primary, fallback: config.fallback, seat: config.seat, pollMs: config.pollMs });
do {
  try { await tick(); } catch (error) { log("poll_error", { error: error instanceof Error ? error.message : String(error) }); }
  if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollMs));
} while (!config.once);

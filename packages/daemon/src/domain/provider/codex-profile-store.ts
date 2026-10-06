import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AccountAuthState } from "./provider-types.js";

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REGISTRY_HEADER = "seat\trig\truntime\tcwd\tauth_profile\tupdated_ts";

export interface CodexProfileStore {
  inspect(name: string): AccountAuthState;
  switchAndBind(input: {
    name: string;
    seat: string;
    rig: string;
    cwd: string;
    switchedAt: string;
  }): { ok: true } | { ok: false; reason: string };
}

interface CodexPaths {
  codexHome: string;
  profileDir: string;
  activeAuth: string;
  registryPath: string;
}

function resolvePaths(env: NodeJS.ProcessEnv): CodexPaths {
  const codexHome = env.CODEX_HOME?.trim() || path.join(env.HOME ?? os.homedir(), ".codex");
  return {
    codexHome,
    profileDir: path.join(codexHome, "auth-profiles"),
    activeAuth: path.join(codexHome, "auth.json"),
    registryPath: path.join(codexHome, "auth-seat-registry.tsv"),
  };
}

function safeRegularFile(file: string, parent: string): fs.Stats | null {
  try {
    const parentReal = fs.realpathSync(parent);
    const fileParentReal = fs.realpathSync(path.dirname(file));
    const stat = fs.lstatSync(file);
    if (parentReal !== fileParentReal || stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return null;
    return stat;
  } catch {
    return null;
  }
}

function profileFile(paths: CodexPaths, name: string): { path: string; stat: fs.Stats } | null {
  if (!PROFILE_NAME_RE.test(name)) return null;
  const candidate = path.join(paths.profileDir, `${name}.json`);
  const stat = safeRegularFile(candidate, paths.profileDir);
  if (!stat || (stat.mode & 0o777) !== 0o600) return null;
  try {
    JSON.parse(fs.readFileSync(candidate, "utf8"));
  } catch {
    return null;
  }
  return { path: candidate, stat };
}

function copySecret(source: string, dest: string, expected?: fs.Stats): boolean {
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  let sourceFd = -1;
  let destFd = -1;
  let bytes: Buffer | null = null;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | noFollow);
    const sourceStat = fs.fstatSync(sourceFd);
    if (!sourceStat.isFile() || sourceStat.nlink !== 1) return false;
    if (expected && (sourceStat.dev !== expected.dev || sourceStat.ino !== expected.ino)) return false;
    bytes = Buffer.alloc(sourceStat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(sourceFd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    if (offset !== bytes.length) return false;
    destFd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
    fs.fchmodSync(destFd, 0o600);
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(destFd, bytes, written, bytes.length - written);
    fs.fsyncSync(destFd);
    fs.closeSync(destFd);
    destFd = -1;
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  } finally {
    if (sourceFd >= 0) try { fs.closeSync(sourceFd); } catch { /* best effort */ }
    if (destFd >= 0) try { fs.closeSync(destFd); } catch { /* best effort */ }
    bytes?.fill(0);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

function registryBody(current: string, input: { seat: string; rig: string; cwd: string; name: string; switchedAt: string }): string | null {
  const fields = [input.seat, input.rig, input.cwd, input.name, input.switchedAt];
  if (fields.some((value) => !value || /[\x00-\x1f\x7f]/.test(value))) return null;
  const rows = current.split("\n")
    .filter((line) => line && !line.startsWith("#") && line !== REGISTRY_HEADER)
    .filter((line) => line.split("\t").length === 6)
    .filter((line) => line.split("\t", 1)[0] !== input.seat);
  rows.push([input.seat, input.rig, "codex", input.cwd, input.name, input.switchedAt].join("\t"));
  return [REGISTRY_HEADER, ...rows].join("\n") + "\n";
}

function writeRegistry(paths: CodexPaths, body: string): boolean {
  const tmp = `${paths.registryPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    const existing = (() => { try { return fs.lstatSync(paths.registryPath); } catch { return null; } })();
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) return false;
    fs.writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, paths.registryPath);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

export function createCodexProfileStore(env: NodeJS.ProcessEnv = process.env): CodexProfileStore {
  const paths = resolvePaths(env);
  return {
    inspect(name) {
      const source = profileFile(paths, name);
      if (!source) return "unknown";
      let probeHome: string | null = null;
      try {
        probeHome = fs.mkdtempSync(path.join(paths.codexHome, ".provider-precheck-"));
        fs.chmodSync(probeHome, 0o700);
        if (!copySecret(source.path, path.join(probeHome, "auth.json"), source.stat)) return "unknown";
        const result = spawnSync("codex", ["login", "status"], {
          env: { ...env, CODEX_HOME: probeHome },
          stdio: "ignore",
          timeout: 15_000,
        });
        if (result.error || result.signal) return "unknown";
        return result.status === 0 ? "active" : "needs_reauth";
      } catch {
        return "unknown";
      } finally {
        if (probeHome) try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    },

    switchAndBind(input) {
      const source = profileFile(paths, input.name);
      if (!source) return { ok: false, reason: "target_profile_invalid_or_unsafe" };
      try {
        fs.mkdirSync(paths.codexHome, { recursive: true, mode: 0o700 });
      } catch {
        return { ok: false, reason: "codex_home_unavailable" };
      }
      const activeStat = (() => { try { return fs.lstatSync(paths.activeAuth); } catch { return null; } })();
      if (activeStat && (activeStat.isSymbolicLink() || !activeStat.isFile() || activeStat.nlink !== 1 || (activeStat.mode & 0o777) !== 0o600)) {
        return { ok: false, reason: "active_auth_unsafe" };
      }
      const currentRegistry = (() => { try { return fs.readFileSync(paths.registryPath, "utf8"); } catch { return ""; } })();
      const nextRegistry = registryBody(currentRegistry, { ...input });
      if (nextRegistry === null) return { ok: false, reason: "invalid_binding_metadata" };

      const backup = `${paths.codexHome}/.provider-auth-backup-${process.pid}-${Date.now()}`;
      const hadActive = activeStat !== null;
      if (hadActive && !copySecret(paths.activeAuth, backup)) return { ok: false, reason: "active_auth_backup_failed" };
      try {
        if (!copySecret(source.path, paths.activeAuth, source.stat)) return { ok: false, reason: "auth_switch_failed" };
        if (!writeRegistry(paths, nextRegistry)) {
          if (hadActive) copySecret(backup, paths.activeAuth);
          else try { fs.rmSync(paths.activeAuth, { force: true }); } catch { /* best effort */ }
          return { ok: false, reason: "seat_binding_update_failed" };
        }
        return { ok: true };
      } finally {
        try { fs.rmSync(backup, { force: true }); } catch { /* best effort */ }
      }
    },
  };
}

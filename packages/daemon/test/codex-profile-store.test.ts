import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexProfileStore } from "../src/domain/provider/codex-profile-store.js";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-profile-store-"));
  roots.push(root);
  const codexHome = path.join(root, "codex");
  const profiles = path.join(codexHome, "auth-profiles");
  const bin = path.join(root, "bin");
  fs.mkdirSync(profiles, { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin, { mode: 0o700 });
  const profile = path.join(profiles, "enterprise.json");
  fs.writeFileSync(profile, JSON.stringify({ auth: "test-secret" }), { mode: 0o600 });
  const codex = path.join(bin, "codex");
  fs.writeFileSync(codex, "#!/bin/sh\n[ \"$1 $2\" = \"login status\" ]\n", { mode: 0o700 });
  return {
    codexHome,
    profile,
    env: { HOME: root, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH ?? ""}` } as NodeJS.ProcessEnv,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CodexProfileStore", () => {
  it("validates, activates and binds a safe profile without exposing its contents", () => {
    const f = fixture();
    const store = createCodexProfileStore(f.env);
    expect(store.inspect("enterprise")).toBe("active");
    expect(store.switchAndBind({
      name: "enterprise",
      seat: "dev@test-rig",
      rig: "test-rig",
      cwd: "/work",
      switchedAt: "2026-10-06T00:00:00.000Z",
    })).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(f.codexHome, "auth.json"), "utf8")).toBe(fs.readFileSync(f.profile, "utf8"));
    expect(fs.statSync(path.join(f.codexHome, "auth.json")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(f.codexHome, "auth-seat-registry.tsv"), "utf8"))
      .toContain("dev@test-rig\ttest-rig\tcodex\t/work\tenterprise\t2026-10-06T00:00:00.000Z");
  });

  it("fails closed for a profile with unsafe permissions", () => {
    const f = fixture();
    fs.chmodSync(f.profile, 0o644);
    const store = createCodexProfileStore(f.env);
    expect(store.inspect("enterprise")).toBe("unknown");
    expect(store.switchAndBind({ name: "enterprise", seat: "dev@rig", rig: "rig", cwd: "/work", switchedAt: "now" }))
      .toEqual({ ok: false, reason: "target_profile_invalid_or_unsafe" });
  });
});

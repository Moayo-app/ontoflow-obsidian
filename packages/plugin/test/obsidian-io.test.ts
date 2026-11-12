import { describe, expect, it } from "vitest";
import { designateHome, openVault, resolveHome } from "../src/core.js";
import { PLUGIN_VAULT_DIR, obsidianFileIo, vaultPath } from "../src/obsidian-io.js";
import { fakeVault } from "./fakes.js";

describe("옵시디언 어댑터 → FileIo (이슈 #42)", () => {
  it("텍스트·바이너리 왕복 — 없는 경로는 null 이다", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    expect(await io.readText("없다.md")).toBeNull();
    expect(await io.readBinary("없다.bin")).toBeNull();
    await io.writeText("a.md", "본문");
    expect(await io.readText("a.md")).toBe("본문");
    await io.writeBinary("b.bin", new Uint8Array([1, 2, 3]));
    expect([...((await io.readBinary("b.bin")) ?? [])]).toEqual([1, 2, 3]);
  });

  it("경로 정규화 — 코어가 조립한 './' 접두가 벗겨져 어댑터에 닿는다", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    await io.writeText("./.ontoflow/x.json", "{}");
    expect(vault.files.has(".ontoflow/x.json")).toBe(true);
    expect(await io.readText("./.ontoflow/x.json")).toBe("{}");
    expect(vaultPath("./a/b")).toBe("a/b");
    expect(vaultPath("/a/b")).toBe("a/b");
  });

  it("rename 은 대상이 있어도 교체다 — 코어의 tmp → 정본 규율이 기댄다", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    await io.writeText("정본.json", "옛것");
    await io.writeText("정본.json.tmp", "새것");
    await io.rename("정본.json.tmp", "정본.json");
    expect(await io.readText("정본.json")).toBe("새것");
    expect(await io.readText("정본.json.tmp")).toBeNull();
  });

  it("remove 는 없는 경로에 무해한 무연산이고, mkdir 는 중첩·중복에 안전하다", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    await io.remove("없다"); // 안 던진다
    await io.mkdir("a/b/c");
    await io.mkdir("a/b/c");
    expect(vault.dirs.has("a")).toBe(true);
    expect(vault.dirs.has("a/b/c")).toBe(true);
  });

  it("openVault 왕복 — 씨앗이 어댑터 경로에 서고 다시 열린다", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    await openVault(io, PLUGIN_VAULT_DIR);
    expect(vault.files.has(".ontoflow/registry.yml")).toBe(true);
    expect(vault.files.has(".ontoflow/graph.sqlite")).toBe(true);
    const again = await openVault(io, PLUGIN_VAULT_DIR);
    expect(again.path).toBe("./.ontoflow/graph.sqlite");
  });

  it("AC4 — vault 밖 홈 지정은 선다 (reachesOutsideVault:false), 안 지정은 된다", async () => {
    const vault = fakeVault();
    const io = obsidianFileIo(vault.adapter);
    await openVault(io, PLUGIN_VAULT_DIR);
    await expect(designateHome(io, PLUGIN_VAULT_DIR, "/Users/누군가/vault-밖")).rejects.toThrow(
      /vault 밖/,
    );
    const moved = await designateHome(io, PLUGIN_VAULT_DIR, "90-시스템/ontoflow");
    expect(moved.moved.length).toBeGreaterThan(0);
    const home = await resolveHome(io, PLUGIN_VAULT_DIR);
    expect(home.dir).toBe("90-시스템/ontoflow");
    expect(home.rel).toBe("90-시스템/ontoflow");
  });
});

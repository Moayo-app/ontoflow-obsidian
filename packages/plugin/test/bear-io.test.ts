// Bear 접근 게이트 (ISSUE-58 AC2·AC4) — macOS 전용·부재 무해 안내·읽기 전용.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bearDbPath, isMacDesktop, readBearDbBytes, type BearFs } from "../src/bear-io.js";

describe("macOS 게이트 (AC4, negative)", () => {
  it("darwin 만 참이고, require 가 없는 런타임(모바일 꼴)은 거짓이다", () => {
    expect(isMacDesktop("darwin")).toBe(true);
    expect(isMacDesktop("win32")).toBe(false);
    expect(isMacDesktop("linux")).toBe(false);
    // vitest(ESM)에는 globalThis.require 가 없다 — 모바일과 같은 조건: 비노출.
    expect(isMacDesktop()).toBe(false);
  });

  it("DB 부재는 오류가 아니라 null — 무해한 안내의 재료다", async () => {
    const missing: BearFs = {
      readFile: async () => {
        throw new Error("ENOENT");
      },
    };
    expect(await readBearDbBytes(missing, "/없는/자리")).toBeNull();
    const present: BearFs = { readFile: async () => new Uint8Array([1, 2]) };
    expect(await readBearDbBytes(present, "/있는/자리")).toEqual(new Uint8Array([1, 2]));
  });

  it("경로 꼴 — 홈 + 고정 상대 경로", () => {
    expect(bearDbPath("/Users/henry/")).toBe(
      "/Users/henry/Library/Group Containers/9K33E3U3T4.net.shinyfrog.bear/Application Data/database.sqlite",
    );
  });
});

describe("쓰기 연산 0 (AC2, negative)", () => {
  it("bear-io 의 파일 연산은 readFile 뿐이다", () => {
    const src = readFileSync(new URL("../src/bear-io.ts", import.meta.url), "utf8");
    expect(src).toMatch(/readFile/);
    expect(src).not.toMatch(/\b(writeFile|appendFile|rename|rm|unlink|mkdir|truncate)\b/);
  });
});

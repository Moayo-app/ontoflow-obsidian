// 문구 카탈로그 (ISSUE-368) — 두 벌의 키 동치·로케일 감지·보간이 축이다.
import { describe, expect, it } from "vitest";

import { PLUGIN_STRINGS, detectLocale, fmt } from "../src/strings.js";

describe("플러그인 문구 카탈로그", () => {
  it("ko·en 두 벌은 같은 키를 지니고, 값은 전부 비지 않은 문자열이다", () => {
    const ko = Object.keys(PLUGIN_STRINGS.ko).sort();
    const en = Object.keys(PLUGIN_STRINGS.en).sort();
    expect(en).toEqual(ko);
    for (const locale of ["ko", "en"] as const) {
      for (const [key, value] of Object.entries(PLUGIN_STRINGS[locale])) {
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("같은 {토큰} 자리가 두 벌에 똑같이 있다 — 보간이 로케일을 타지 않는다", () => {
    const tokens = (s: string) => [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(PLUGIN_STRINGS.ko) as (keyof typeof PLUGIN_STRINGS.ko)[]) {
      expect(tokens(PLUGIN_STRINGS.en[key]), String(key)).toEqual(tokens(PLUGIN_STRINGS.ko[key]));
    }
  });

  it("로케일은 옵시디언 getLanguage() 값에서 정한다 — ko 만 ko, 그 외·빈 값은 en", () => {
    expect(detectLocale("ko")).toBe("ko");
    expect(detectLocale("ja")).toBe("en");
    expect(detectLocale("en")).toBe("en");
    expect(detectLocale("")).toBe("en");
  });

  it("fmt 는 {토큰}을 치환하고 모르는 토큰은 그대로 둔다", () => {
    expect(fmt("노트 {n}건 — {name}", { n: 3, name: "vault" })).toBe("노트 3건 — vault");
    expect(fmt("잔량 {left}", { other: 1 })).toBe("잔량 {left}");
  });
});

// 출고 계약 (ISSUE-105) — 「설치되는가」를 시험이 문다. 여기 선 항목은 전부 실측으로 깨진 적이
// 있거나, 깨지면 마켓 설치본이 조용히 고장나는 자리다. 전수 스캔 꼴은 허브 safeLogger 스캔(#43) 승계다.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { configureSqlJs, loadDictionary, openVault } from "../src/core.js";
import { PLUGIN_VAULT_DIR, obsidianFileIo } from "../src/obsidian-io.js";
import { fakeVault } from "./fakes.js";

const require = createRequire(import.meta.url);
const repoRoot = new URL("../../../", import.meta.url);
const pkgRoot = new URL("../", import.meta.url);

const read = (base: URL, rel: string): string => readFileSync(new URL(rel, base), "utf8");
const srcFiles = [
  "bear-io.ts",
  "commands.ts",
  "core.ts",
  "hub-client.ts",
  "main.ts",
  "net.ts",
  "obsidian-io.ts",
  "registry-io.ts",
  "screens.ts",
  "settings.ts",
  "source-io.ts",
  "sql-wasm.ts",
  "sync.ts",
] as const;

interface Manifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  authorUrl?: string;
  isDesktopOnly: boolean;
}

const manifest = JSON.parse(read(pkgRoot, "manifest.json")) as Manifest;

describe("설치 산출물 — wasm 내장 (AC1·AC2)", () => {
  it("wasmBinary 단독으로 sql.js 가 선다 — 파일 접근 0", async () => {
    // 빌드가 하는 일(파일 → base64)과 런타임이 하는 일(base64 → ArrayBuffer)을 그대로 재현한다.
    // 옵시디언에서는 base64ToArrayBuffer 가 뒷단을 맡는다 — 자리만 다르고 바이트는 같다.
    const bytes = readFileSync(require.resolve("sql.js/dist/sql-wasm.wasm"));
    const base64 = bytes.toString("base64");
    const decoded = Buffer.from(base64, "base64");
    expect(decoded.equals(bytes)).toBe(true);

    const wasmBinary = decoded.buffer.slice(
      decoded.byteOffset,
      decoded.byteOffset + decoded.byteLength,
    ) as ArrayBuffer;
    configureSqlJs({ wasmBinary });

    // 여기서 서면 wasm 해석 경로(fetch·파일)가 한 번도 필요하지 않았다는 뜻이다.
    const store = await openVault(obsidianFileIo(fakeVault().adapter), PLUGIN_VAULT_DIR);
    expect(loadDictionary(store)).toBeDefined();
  });

  it("플러그인 디렉터리의 wasm 파일을 기대하는 코드가 없다 — 설치기는 세 파일만 내려받는다", () => {
    for (const f of srcFiles) {
      expect(read(pkgRoot, `src/${f}`), f).not.toMatch(/sql-wasm\.wasm/);
    }
  });

  it("빌드는 wasm 을 번들에 심고 dist 에 네 번째 파일을 떨구지 않는다", () => {
    const build = read(pkgRoot, "esbuild.config.mjs");
    expect(build).toMatch(/__ONTOFLOW_SQL_WASM_BASE64__/);
    expect(build).not.toMatch(/copyFile\([^)]*wasm/);
    // 난독화 금지(개발자 정책) — minify 를 켠 채로 심사에 들어가지 않는다.
    expect(build).not.toMatch(/minify:\s*true/);
  });
});

describe("루트 미러 드리프트 가드 (AC4)", () => {
  // 커뮤니티 디렉터리는 기본 브랜치 HEAD 의 **루트** manifest.json 을 읽는다. 모노레포라
  // 정본은 packages/plugin/manifest.json 이고 루트는 미러다 — 미러가 조용히 썩으면 마켓에
  // 뜬 버전과 릴리스가 어긋난다. 그래서 시험이 둘을 묶는다.
  it("루트 manifest.json 이 플러그인 정본과 한 글자도 다르지 않다", () => {
    expect(JSON.parse(read(repoRoot, "manifest.json"))).toEqual(manifest);
  });

  it("versions.json 이 현재 버전→minAppVersion 을 든다", () => {
    const versions = JSON.parse(read(repoRoot, "versions.json")) as Record<string, string>;
    expect(versions[manifest.version]).toBe(manifest.minAppVersion);
  });
});

describe("manifest 규격 (옵시디언 매니페스트 참조)", () => {
  it("id 는 소문자·하이픈이고 obsidian 을 품지 않으며 plugin 으로 끝나지 않는다", () => {
    expect(manifest.id).toMatch(/^[a-z-]+$/);
    expect(manifest.id).not.toMatch(/obsidian/);
    expect(manifest.id.endsWith("plugin")).toBe(false);
  });

  it("name 은 Basic Latin + 허용 구두점뿐이고 Obsidian·Plugin 을 품지 않는다", () => {
    expect(manifest.name).toMatch(/^[A-Za-z0-9 ()+-]+$/);
    expect(manifest.name).not.toMatch(/obsidian|obsi-|-sidian/i);
    expect(manifest.name).not.toMatch(/plugin/i);
  });

  it("version 은 x.y.z 이고 minAppVersion·author·description 이 선다", () => {
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.minAppVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.author.length).toBeGreaterThan(0);
    // 등재 한 줄이 잘려 나가지 않는 길이 (디렉터리 표시 여유).
    expect(manifest.description.length).toBeLessThanOrEqual(250);
    expect(typeof manifest.isDesktopOnly).toBe("boolean");
  });

  // 디렉터리의 플러그인 페이지가 작성자 이름을 이 URL 로 건다 — 마켓에서 우리 밖으로 나가는
  // 유일한 링크다. 평문 http 면 중간자가 퍼널 첫 걸음을 바꿔치기할 수 있고(사이트 쪽 같은 판단),
  // 호스트가 우리 것이 아니면 퍼널이 남의 자리로 샌다. 선택 필드지만 **들었으면** 둘을 센다.
  it("authorUrl 은 들었으면 https 이고 우리 호스트다", () => {
    if (manifest.authorUrl === undefined) return;
    const url = new URL(manifest.authorUrl);
    expect(url.protocol).toBe("https:");
    expect(url.hostname === "ontoflow.app" || url.hostname.endsWith(".ontoflow.app")).toBe(true);
  });
});

describe("가이드라인 — 커맨드·전송·텔레메트리", () => {
  it("커맨드 id 에 플러그인 id 를 붙이지 않는다 — 옵시디언이 자동으로 앞에 세운다", () => {
    const main = read(pkgRoot, "src/main.ts");
    const ids = [...main.matchAll(/addCommand\(\{\s*id:\s*"([^"]+)"/g)].map((m) => m[1] as string);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith(manifest.id), id).toBe(false);
  });

  it("전송은 requestUrl 뿐이다 — 전역 fetch 호출·주입 0 (플러그인 출처는 CORS 를 받는다)", () => {
    // 호출(`fetch(`)만이 아니라 값으로 넘기는 꼴(`hubClient(a, b, fetch)`)도 잡는다 —
    // 전역 fetch 가 전송으로 주입되는 순간 CORS 가 돌아온다.
    for (const f of srcFiles) {
      expect(read(pkgRoot, `src/${f}`), f).not.toMatch(
        /(^|[^.\w])fetch\s*[(,);]|\b(window|globalThis)\.fetch\b/m,
      );
    }
    const net = read(pkgRoot, "src/net.ts");
    expect(net).toMatch(/requestUrl/);
    // throw:false 가 없으면 4xx 가 예외로 바뀌어 problems 를 읽을 수 없다 (#12 AC5 의 보류 판정).
    expect(net).toMatch(/throw:\s*false/);
  });

  it("텔레메트리·로그 0 — 기본 콘솔에는 아무것도 싣지 않는다", () => {
    for (const f of srcFiles) {
      const text = read(pkgRoot, `src/${f}`);
      expect(text, f).not.toMatch(/\bconsole\s*\./);
      expect(text, f).not.toMatch(/analytics|telemetry|mixpanel|posthog|sentry|gtag/i);
    }
  });
});

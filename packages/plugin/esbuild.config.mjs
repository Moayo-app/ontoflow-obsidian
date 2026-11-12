// 옵시디언 번들 — src/main.ts → dist/main.js (cjs). CI 는 이 빌드를 돌리지 않는다(타입 검사·테스트만).
//
// 산출물은 두 파일로 닫힌다: main.js · manifest.json (이슈 #105 AC1).
// ⭐ 세 번째 파일을 늘리지 않는 것이 이 설정의 계약이다 — 옵시디언 커뮤니티 설치기는 릴리스에서
//    main.js·manifest.json·styles.css 만 내려받는다. 예전 빌드는 sql-wasm.wasm 을 네 번째
//    파일로 떨구고 런타임이 플러그인 디렉터리에서 그것을 읽었다 — 마켓 설치본에는 그 파일이
//    없으니 정본(SQLite)이 열리지 않는, 설치 즉시 고장이었다. wasm 을 원격에서 당겨오는 길
//    (locateFile → CDN)은 개발자 정책의 원격 코드 금지에 걸린다. 그래서 번들 내장이다:
//    빌드 시점 base64 → 런타임 base64ToArrayBuffer → configureSqlJs({ wasmBinary }) (#49 주입 자리).
import esbuild from "esbuild";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wasm = await readFile(require.resolve("sql.js/dist/sql-wasm.wasm"));

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/main.js",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  // wasm 을 빌드 시점에 심는다 — 런타임의 파일·네트워크 의존 0 (src/sql-wasm.ts 가 받는다).
  define: { __ONTOFLOW_SQL_WASM_BASE64__: JSON.stringify(wasm.toString("base64")) },
  // minify 를 켜지 않는다 — 개발자 정책은 심사 가능한(난독화되지 않은) 산출물을 요구한다.
  logLevel: "info",
});

await mkdir("dist", { recursive: true });
await copyFile("manifest.json", "dist/manifest.json");

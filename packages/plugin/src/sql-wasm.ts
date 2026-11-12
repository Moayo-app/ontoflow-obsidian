// sql.js wasm 내장 (#105 AC1·AC2) — 빌드가 base64 로 심고(esbuild define), 여기서 편다.
//
// 왜 파일이 아니라 번들인가: 옵시디언 커뮤니티 설치기는 릴리스의 main.js·manifest.json·
// styles.css 만 내려받는다 — 플러그인 디렉터리에 wasm 파일을 기대하는 코드는 마켓 설치본에서
// 반드시 깨진다. 원격 당겨오기(CDN)는 개발자 정책의 원격 코드 금지에 걸린다. 남는 길은 내장뿐이다.
import { base64ToArrayBuffer } from "obsidian";
import { configureSqlJs } from "./core.js";

/** 빌드가 꽂는 자리 — esbuild define. 빌드를 지나지 않은 실행(테스트 등)에서는 서지 않는다. */
declare const __ONTOFLOW_SQL_WASM_BASE64__: string;

/**
 * 내장 wasm 바이트 — configureSqlJs({ wasmBinary }) 의 입력.
 * define 이 꽂히지 않은 채로 실행되면 조용한 0 이 아니라 명시 오류다: 빌드 계약이 깨진 것이라
 * 그 자리에서 서야 한다 (닫힌 기본).
 */
export function sqlWasmBinary(): ArrayBuffer {
  if (typeof __ONTOFLOW_SQL_WASM_BASE64__ !== "string" || __ONTOFLOW_SQL_WASM_BASE64__ === "") {
    throw new Error("sql.js wasm 이 번들에 심기지 않았다 — esbuild.config.mjs 의 define 계약 위반");
  }
  return base64ToArrayBuffer(__ONTOFLOW_SQL_WASM_BASE64__);
}

// 두 번 부르면 코어가 던진다(「이미 초기화됐다」 — 주입은 첫 openVault 전이어야 하니 옳은 계약).
// 플러그인 비활성→활성이 모듈 자리를 유지하는 경우, 두 번째 onload 가 그 예외로 통째로 넘어갈
// 수 있다. 그래서 여기서 한 번만 통과시킨다 — 이 깃발과 코어의 초기화 상태는 같은 번들 자리에
// 사니 늘 함께 선다(모듈이 새로 평가되면 둘 다 초기값으로 돌아간다).
let configured = false;

/** onload 에서 부른다 — 멱등. 첫 openVault 보다 앞이어야 한다. */
export function configureEmbeddedSqlJs(): void {
  if (configured) return;
  configureSqlJs({ wasmBinary: sqlWasmBinary() });
  configured = true;
}

// 수집함 캡처 판정 (#75 보강 결의) — 외부 LLM 의 「이 대화 저장해」가 놓고 가는 파일 한 장의
// 규율. 캡처는 그래프 쓰기가 아니라 소스 유입이다: 수집함(vault 안 고정 폴더)에 md 로 서고,
// 이후는 기존 파이프라인(수집→추출→리뷰 큐 사용자 확정→그래프→합성)이다 — 그래프 직행 0.
// 쓸 수 있는 자리는 이 폴더 하나뿐이고 경로는 제목에서 소독해 만든다 — 임의 파일 쓰기 통로 0 (AC6).
import type { FileIo } from "./store.js";

export class CaptureError extends Error {
  constructor(readonly problems: string[]) {
    super(`캡처 거부:\n- ${problems.join("\n- ")}`);
    this.name = "CaptureError";
  }
}

/** 수집함 — vault 안 고정 폴더. 기계 자리(합성 ontoflow-notes)·홈(.ontoflow)과 달리 수집 대상이다. */
export const CAPTURE_DIR = "ontoflow-inbox";

/**
 * 서러게이트 안전 절단 (#441) — `slice(0, n)` 은 UTF-16 짝(이모지·보충 평면 한자)을 반으로
 * 갈라 외톨이 서러게이트를 남긴다: URI 인코딩·파일명에서 � 로 깨진다. 상한은 UTF-16 단위
 * 그대로 두되(호출부 계약 무변) 코드 포인트 경계에서만 자른다 — clip·capture·sources 공용.
 */
export function sliceAtCodePoint(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

// 파일명 소독 — 경로 구분자·순회·옵시디언 금지 문자를 접는다 (sources.ts 와 같은 결).
function sanitizeTitle(title: string): string {
  const flat = title
    .replace(/[\\/:#^[\]|?*]/g, " ")
    .replace(/\.+/g, ".")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return sliceAtCodePoint(flat, 120).trim();
}

export interface CaptureInput {
  title: string;
  md: string;
}

/** 캡처 한 장 — 같은 제목은 타임스탬프로 갈라 선다(덮어쓰기 0: 캡처는 소유 이전이 없는 유입이다). */
export async function captureToInbox(
  io: FileIo,
  vaultDir: string,
  input: CaptureInput,
  now: string,
): Promise<{ path: string }> {
  const problems: string[] = [];
  const title = sanitizeTitle(typeof input.title === "string" ? input.title : "");
  if (title.length === 0) problems.push("제목이 비어 있다 — 소독 뒤 남는 글자가 있어야 한다");
  if (typeof input.md !== "string" || input.md.trim().length === 0) problems.push("본문(md)이 비어 있다");
  if (problems.length > 0) throw new CaptureError(problems);

  const dir = `${vaultDir}/${CAPTURE_DIR}`;
  await io.mkdir(dir);
  let path = `${dir}/${title}.md`;
  if ((await io.readText(path)) !== null) {
    const stamp = now.replace(/[:.]/g, "-");
    path = `${dir}/${title} ${stamp}.md`;
  }
  await io.writeText(path, input.md);
  return { path };
}

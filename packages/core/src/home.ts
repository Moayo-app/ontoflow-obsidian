// 그래프 홈 지정 (이슈 #31) — 홈 전체(정본·등록부·상태)를 사용자 지정 자리로 옮긴다.
// 해석(resolveHome)은 store.ts 에 있고, 여기는 이동만 산다: 복사 → 포인터 커밋 → 원본 제거
// 3단. 커밋 전 실패는 완전 원위치(원본 무손상 — 새 자리의 복사본만 치운다)고, 포인터 교체가
// 곧 전환이다 — 정본 하나 불변식, 두 벌 금지 (AC3). 지정 가능한 자리는 사용자 소유 저장
// 자리뿐이다: 이 함수에는 원격 대상 자체가 없다 (허브 보관 선택지 없음 — 보관 0).
import { COLLECT_STATE_FILE, HOLD_FILE } from "./collect.js";
import { ONBOARDING_FILE } from "./onboarding.js";
import { RESURFACE_STATE_FILE } from "./resurface.js";
import { REVIEW_FILE } from "./review.js";
import { SOURCES_STATE_FILE } from "./sources.js";
import { SYNTHESIS_STATE_FILE } from "./synthesis.js";
import {
  DB_FILE,
  HOME_POINTER_FILE,
  ONTOFLOW_DIR,
  REGISTRY_FILE,
  StoreError,
  resolveHome,
  vaultRelative,
  type FileIo,
} from "./store.js";

// 홈의 닫힌 파일 집합 — FileIo 에는 목록 연산이 없으므로 「홈 전체」는 이 집합으로 정의된다.
// 홈에 파일을 더하는 모듈은 반드시 여기에도 올린다 (빠지면 이동에서 누락된다).
export const HOME_FILES = [
  DB_FILE,
  REGISTRY_FILE,
  COLLECT_STATE_FILE,
  HOLD_FILE,
  REVIEW_FILE,
  ONBOARDING_FILE,
] as const;

export interface DesignateResult {
  from: string;
  to: string;
  /** 실제로 옮긴 파일명 — 아직 안 생긴 상태 파일은 옮길 것이 없다. */
  moved: string[];
}

// 포인터 반영은 정본 persist 와 같은 규율 — 임시 파일 + rename 원자 교체.
async function writePointer(io: FileIo, vaultDir: string, home: string): Promise<void> {
  const dir = `${vaultDir}/${ONTOFLOW_DIR}`;
  await io.mkdir(dir);
  const path = `${dir}/${HOME_POINTER_FILE}`;
  const tmp = `${path}.tmp`;
  try {
    await io.writeText(tmp, JSON.stringify({ home }));
    await io.rename(tmp, path);
  } catch (e) {
    await io.remove(tmp).catch(() => {});
    throw e;
  }
}

export async function designateHome(
  io: FileIo,
  vaultDir: string,
  newDir: string,
): Promise<DesignateResult> {
  const cur = await resolveHome(io, vaultDir); // 현 홈 검증 포함 — 소실된 홈 위에서 지정하지 않는다 (AC4)
  const to = newDir.replace(/\/+$/, "");
  if (to.trim() === "") throw new StoreError(["지정할 홈 경로가 비어 있다"]);
  if (to === cur.dir) return { from: cur.dir, to, moved: [] }; // 같은 자리 — 무해한 무연산
  const rel = vaultRelative(vaultDir, to);
  if (rel === "") throw new StoreError(["vault 루트는 홈이 될 수 없다 — 노트 자리와 섞인다"]);
  if (rel === null && io.reachesOutsideVault !== true) {
    // AC6 — 옵시디언 모바일의 DataAdapter 등 vault 한정 구현. 처리 0 으로 선다.
    throw new StoreError([
      `이 FileIo 는 vault 밖에 닿지 않는다 — vault 밖 홈 지정 불가: ${to}`,
    ]);
  }

  await io.mkdir(to);
  // 1) 복사 — 원본은 커밋까지 무손상이다.
  const moved: string[] = [];
  try {
    for (const name of HOME_FILES) {
      const bytes = await io.readBinary(`${cur.dir}/${name}`);
      if (bytes === null) continue;
      await io.writeBinary(`${to}/${name}`, bytes);
      moved.push(name);
    }
    // 2) 커밋 — 포인터가 곧 정본의 자리다.
    await writePointer(io, vaultDir, to);
  } catch (e) {
    // 원위치 (AC3) — 원본은 건드린 적이 없으니 새 자리의 복사본만 치운다. 반쪽 상태 0.
    for (const name of moved) await io.remove(`${to}/${name}`).catch(() => {});
    throw e;
  }
  // 3) 옛 자리 정리 — 커밋 뒤라 정본은 이미 새 자리다. 실패하면 찌꺼기를 알려 수동 삭제를 맡긴다.
  const leftovers: string[] = [];
  for (const name of moved) {
    try {
      await io.remove(`${cur.dir}/${name}`);
    } catch {
      leftovers.push(`${cur.dir}/${name}`);
    }
  }
  if (leftovers.length > 0) {
    throw new StoreError([
      `지정은 완료됐다 (${to}) — 옛 자리 정리가 실패해 사본이 남았다, 수동 삭제 필요:`,
      ...leftovers,
    ]);
  }
  return { from: cur.dir, to, moved };
}

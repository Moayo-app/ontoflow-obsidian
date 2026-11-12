// 옵시디언 DataAdapter → 코어 FileIo (이슈 #42). 어댑터는 vault 한정 구현이므로
// reachesOutsideVault 는 false 다 — vault 밖 홈 지정은 코어 designateHome 이 거부한다 (AC4).
import type { FileIo } from "./core.js";

/** 옵시디언 DataAdapter 의 구조적 부분집합 — 런타임은 `app.vault.adapter`, 테스트는 메모리 구현이 충족한다. */
export interface ObsidianDataAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** 플러그인의 vaultDir — 옵시디언 경로는 전부 vault 상대라 루트는 "." 이다. */
export const PLUGIN_VAULT_DIR = ".";

// 코어가 `${vaultDir}/…` 로 조립한 "./.ontoflow/…" 꼴을 어댑터가 받는 vault 상대 경로로 편다.
//
// 정규화는 옵시디언 `normalizePath` 와 같은 일을 한다(역슬래시→`/` · 중복 슬래시 접기 ·
// 앞뒤 슬래시 제거 · 유니코드 NFC): 사용자 입력 경로(홈 지정 #31 · 합성 자리 #59)가 그대로
// 어댑터에 닿는 자리라 가이드라인이 요구하는 단계다. 심볼을 import 하지 않고 직접 구현하는
// 이유는 `obsidian` 패키지가 타입만 싣고 런타임 모듈이 없어서다 — 이 모듈은 단위 시험 대상이고,
// 시험 런타임에는 옵시디언이 없다. NFC 가 특히 실물이다: macOS 는 한글 파일명을 NFD 로 준다.
export function vaultPath(path: string): string {
  let out = path.replace(/\\/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .normalize("NFC");
}

export function obsidianFileIo(adapter: ObsidianDataAdapter): FileIo {
  const existing = async (p: string): Promise<string | null> => {
    const path = vaultPath(p);
    return (await adapter.exists(path)) ? path : null;
  };
  return {
    reachesOutsideVault: false,
    async readText(p) {
      const path = await existing(p);
      return path === null ? null : adapter.read(path);
    },
    async readBinary(p) {
      const path = await existing(p);
      return path === null ? null : new Uint8Array(await adapter.readBinary(path));
    },
    async writeText(p, text) {
      await adapter.write(vaultPath(p), text);
    },
    async writeBinary(p, data) {
      const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
      await adapter.writeBinary(vaultPath(p), buf);
    },
    async rename(from, to) {
      // 옵시디언 어댑터의 rename 은 대상이 이미 있을 때의 동작이 플랫폼마다 다르다. 코어의
      // 임시 파일 교체(tmp → 정본)가 기대는 것은 「교체」라서, 덮어쓰기가 보장되는 writeBinary
      // 로 옮기고 원본을 거둔다 — 중간에 실패해도 남는 건 임시 파일뿐, 정본은 무손상이다.
      const f = vaultPath(from);
      const bytes = await adapter.readBinary(f);
      await adapter.writeBinary(vaultPath(to), bytes);
      await adapter.remove(f);
    },
    async mkdir(p) {
      // 어댑터 mkdir 의 재귀·중복 동작이 구현마다 달라 마디별로, 이미 있으면 건너뛰며 만든다.
      const parts = vaultPath(p)
        .split("/")
        .filter((s) => s.length > 0);
      let cur = "";
      for (const part of parts) {
        cur = cur === "" ? part : `${cur}/${part}`;
        if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
      }
    },
    async remove(p) {
      // 없는 경로의 제거는 무해한 무연산 — FileIo 계약 (#31 홈 이동의 원위치·정리가 기댄다).
      const path = await existing(p);
      if (path !== null) await adapter.remove(path);
    },
  };
}

// Bear 로컬 접근 (ISSUE-58) — macOS 데스크톱 전용 게이트와 DB 바이트 읽기. 제1 규율:
// Bear DB 에는 결코 쓰지 않는다 — 이 모듈의 파일 연산은 readFile 하나뿐이다 (AC2).
// 다른 플랫폼에서는 기능 자체가 비노출이고(AC4 — 게이트), DB 부재는 무해한 안내다.
import { BEAR_DB_RELATIVE_PATH } from "./core.js";

export interface BearFs {
  readFile(path: string): Promise<Uint8Array>;
}

interface NodeLike {
  platform?: string;
  homedir?: () => string;
}

function nodeRequire(): ((m: string) => unknown) | null {
  const req = (globalThis as { require?: (m: string) => unknown }).require;
  return typeof req === "function" ? req : null;
}

/** macOS 데스크톱인가 — 아니면 Bear 기능은 비노출이다 (AC4). 주입은 테스트 자리다. */
export function isMacDesktop(platform?: string): boolean {
  if (platform !== undefined) return platform === "darwin";
  const req = nodeRequire();
  if (req === null) return false; // 모바일 — node 가 없다
  try {
    return (req("node:process") as NodeLike).platform === "darwin";
  } catch {
    return false;
  }
}

/** Bear DB 절대 경로 — 홈 디렉터리 + 고정 상대 경로. */
export function bearDbPath(homedir: string): string {
  return `${homedir.replace(/\/+$/, "")}/${BEAR_DB_RELATIVE_PATH}`;
}

export function nodeBearFs(): { fs: BearFs; homedir: string } {
  const req = nodeRequire();
  if (req === null) throw new Error("Bear 수집은 macOS 데스크톱 전용이다 — 이 기기에는 파일시스템 접근이 없다");
  const os = req("node:os") as { homedir(): string };
  const fsp = req("node:fs/promises") as { readFile(path: string): Promise<Uint8Array> };
  return { fs: { readFile: (p) => fsp.readFile(p) }, homedir: os.homedir() };
}

/** DB 바이트 읽기 — 부재(미설치)는 오류가 아니라 null: 무해한 안내의 재료다 (AC4). */
export async function readBearDbBytes(fs: BearFs, path: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(path);
  } catch {
    return null; // 미설치·권한 전부 같은 답 — 반쯤 연결이 없다
  }
}

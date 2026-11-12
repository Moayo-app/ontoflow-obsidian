// 커맨드 판단층 — 옵시디언 커맨드 팔레트 뒤의 실제 일. UI 없이 시험 가능하다.
import {
  exportGraphMl,
  exportJsonLd,
  projectionDataFor,
  projectNote,
  type FileIo,
  type GraphStore,
  type Registry,
} from "./core.js";

// 노트 하나 투영 — 정본 → frontmatter 구조화 목록. 무변 재투영은 쓰지 않는다 (수집 비용 0).
export async function projectNoteCommand(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  notePath: string,
): Promise<{ changed: boolean }> {
  return projectNote(io, vaultDir, notePath, projectionDataFor(store, notePath));
}

export type ExportFormat = "jsonld" | "graphml";

export const EXPORT_FILES: Record<ExportFormat, string> = {
  jsonld: "ontoflow-export.jsonld",
  graphml: "ontoflow-export.graphml",
};

// 내보내기 — 로컬·무료 (v1 집합). vault 루트에 원자 쓰기, 돌려주는 값은 파일 이름이다.
export async function exportCommand(
  io: FileIo,
  vaultDir: string,
  store: GraphStore,
  registry: Registry,
  format: ExportFormat,
): Promise<string> {
  const text = format === "jsonld" ? exportJsonLd(store, registry) : exportGraphMl(store, registry);
  const path = `${vaultDir}/${EXPORT_FILES[format]}`;
  const tmp = `${path}.tmp`;
  await io.writeText(tmp, text);
  await io.rename(tmp, path);
  return EXPORT_FILES[format];
}

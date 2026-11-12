// 금고 목적지의 이름 — 타입뿐인 잎 모듈 (#326).
//
// 원래 `vault.ts`(자격증명 금고)에 살았는데, `billing.ts` 가 이 유니온 하나 때문에 금고
// 모듈 전체를 타입으로 물었다. 옵시디언 공개 미러(#326)는 번들의 전이 폐쇄만 싣는데
// billing 이 폐쇄에 들어 있어, 타입 참조 하나가 서버 모듈의 공개를 끌고 오는 꼴이었다.
// 그래서 이름 유니온만 여기로 — 비밀이 없다: 연결 가능한 목적지의 **이름 목록**이고,
// 전부 공개 기능명이다. `vault.ts` 가 재수출하므로 기존 호출부는 무변이다.

export type Destination =
  | "notion"
  | "notion-ingest"
  | "postgres"
  | "onenote"
  | "onenote-synthesis"
  | "evernote"
  | "evernote-synthesis"
  | "gdrive"
  | "dropbox"
  | "gitlab"
  | "github"
  | "atlassian";

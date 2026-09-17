import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

// bun test는 NODE_ENV=test로 실행된다 — 테스트가 운영 DB를 건드리지 않도록 메모리 DB 사용
export const db = new Database(process.env.NODE_ENV === "test" ? ":memory:" : join(DATA_DIR, "mybot.db"), { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '새 대화',
  model TEXT,
  persona_id TEXT,
  workspace_id TEXT,
  mode TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  reasoning TEXT,
  model TEXT,
  search_meta TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  avatar TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  source_conversation_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  conversation_id TEXT,
  name TEXT NOT NULL,
  mime TEXT,
  path TEXT NOT NULL,
  size INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,
  avatar TEXT,
  tools TEXT,
  persistent INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  conversation_id TEXT,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  result TEXT,
  steps INTEGER,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, created_at);

-- 봇이 브라우저로 자동 로그인할 사이트 계정 (비밀번호는 AES-256-GCM 암호화, 로컬 DB에만 저장)
CREATE TABLE IF NOT EXISTS site_logins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- 봇이 사용자에게 요청한 계정 입력 — 팝업으로 수집, 완료/거절 시 상태 변경
CREATE TABLE IF NOT EXISTS credential_requests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

-- 대화 롤링 요약 — 오래된 메시지는 요약으로 압축해 프롬프트 크기를 일정하게 유지
CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  covers_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

db.exec(`
-- 승인 경계 — 외부 영향 액션 실행 전 사용자 승인 큐 (그록 Auto Review 대응)
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  args TEXT,
  summary TEXT,
  agent_id TEXT,
  resume TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
-- pattern(정규식)이 도구명에 매치 → action: require(승인 필요) / allow(항상 허용). require가 우선
CREATE TABLE IF NOT EXISTS approval_rules (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- 봇 간 비동기 메시지 — 보낸 봇은 기다리지 않고, 받는 봇이 백그라운드 처리 후 회신
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT,
  to_agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reply TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
-- 그룹채팅 — 여러 봇이 하나의 대화에 참여 (@멘션으로 특정 봇 지정 가능)
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// 스킬 — `/요약` 같은 슬래시 명령과 봇이 학습한 업무 절차(skill_save)를 함께 담는다.
// 이전에는 routes/workspaces.ts에서 생성돼 스키마가 두 파일로 갈라져 있었고,
// 신규 설치에서는 아래 ALTER가 조용히 실패한 뒤 뒤늦게 다시 ALTER되는 구조였다.
db.exec(`
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  agent_id TEXT,
  created_at INTEGER NOT NULL
);
`);

try { db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT"); } catch {}
try { db.exec("ALTER TABLE routines ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE routines ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'schedule'"); } catch {}
try { db.exec("ALTER TABLE routines ADD COLUMN email_filter TEXT"); } catch {}
try { db.exec("ALTER TABLE routines ADD COLUMN webhook_token TEXT"); } catch {} // A9 — 웹훅 트리거 수신 토큰
try { db.exec("ALTER TABLE routines ADD COLUMN match_rule TEXT"); } catch {} // A9 — 웹훅 매칭 규칙 {"sender_field","sender","contains":[]}
try { db.exec("ALTER TABLE agents ADD COLUMN workspace_id TEXT"); } catch {} // C19 — 봇의 프로젝트(워크스페이스) 배정
try { db.exec("ALTER TABLE memories ADD COLUMN workspace_id TEXT"); } catch {} // C19 — 프로젝트 공유 메모리
try { db.exec("ALTER TABLE skills ADD COLUMN agent_id TEXT"); } catch {} // 구 스키마 호환 (신규 DB는 위 CREATE에 포함)
try { db.exec("ALTER TABLE agents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN group_id TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN is_boss INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE agent_runs ADD COLUMN tool_log TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_runs ADD COLUMN routine_id TEXT"); } catch {} // 루틴별 실행이력 보존·조회 키
try { db.exec("ALTER TABLE agent_runs ADD COLUMN resume_count INTEGER"); } catch {} // 재시작 후 재개 횟수 — 3회 초과 시 error 확정
try { db.exec("ALTER TABLE approval_rules ADD COLUMN cond TEXT"); } catch {} // A12 — 인자 조건 규칙 {"field","op","value"}
try { db.exec("ALTER TABLE site_logins ADD COLUMN success_check TEXT"); } catch {} // C20 — 사이트별 로그인 성공 기준 (CSS 선택자 또는 url:정규식)
try { db.exec("ALTER TABLE skills ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0"); } catch {} // A8 — 성공률 미달 자동 비활성
// C15 — 장기기억 FTS5: content 전문검색 인덱스 + 중요도(weight)·마지막 회상(last_seen)·아카이브(archived)
try { db.exec("ALTER TABLE memories ADD COLUMN weight INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE memories ADD COLUMN last_seen INTEGER"); } catch {}
try { db.exec("ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0"); } catch {}
db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='memories', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END;
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content); END;
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END;
`);
// 기존 행을 FTS로 싱크 — external-content FTS의 COUNT는 백업 테이블을 읽어 인덱스 유무를 못 보므로 설정 플래그로 1회 rebuild
try {
  const flag = db.prepare("SELECT value FROM settings WHERE key = 'memories_fts_v1'").get() as any;
  if (!flag) {
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('memories_fts_v1', '1')").run();
  }
} catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS skill_runs (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  agent_id TEXT,
  ok INTEGER,               -- NULL=참조됨(런 진행 중), 1=런 성공, 0=런 실패
  fail_reason TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS handoff_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  run_id TEXT,
  reason TEXT,
  url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER,
  resolved_at INTEGER
)`); } catch {} // A2 — 테이크오버 인계 대기열
try { db.exec("CREATE INDEX IF NOT EXISTS idx_agent_runs_routine ON agent_runs(routine_id, created_at)"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN parent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN is_lead INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN max_children INTEGER"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN sort_order REAL"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN special_role TEXT"); } catch {} // 'org_admin'(Eggbot, 봇 관리 전담) / 'secretary'(비서실장, 업무 라우팅)
// 조직 역할 자동 배정 — 이름 기준 1회 백필 (Eggbot=조직관리, 비서실장=라우팅)
db.exec("UPDATE agents SET special_role = 'org_admin' WHERE name = 'Eggbot' AND special_role IS NULL");
db.exec("UPDATE agents SET special_role = 'secretary' WHERE name = '비서실장봇' AND special_role IS NULL");
// 업무 트리 무결성 — 최대 2단계(CEO→팀장→봇). 잘못된 배정은 기동 시 자동 복구:
// ① 특수 역할 봇(Eggbot·비서실장)은 항상 CEO 직속 ② 팀장도 CEO 직속
// ③ parent는 팀장·CEO만 가능 ④ 3단계 이상 금지
db.exec("UPDATE agents SET parent_id = NULL WHERE special_role IS NOT NULL AND parent_id IS NOT NULL");
db.exec("UPDATE agents SET parent_id = NULL WHERE is_lead = 1 AND parent_id IS NOT NULL");
db.exec("UPDATE agents SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM agents WHERE is_lead = 1 OR is_boss = 1)");
db.exec("UPDATE agents SET parent_id = NULL WHERE parent_id IN (SELECT id FROM agents WHERE parent_id IS NOT NULL)");
{ // 정렬값 백필 — 기존 표시 순서(CEO→핀→생성순)를 유지한 채 순번 부여
  let i = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) m FROM agents").get() as any).m;
  for (const r of db.prepare("SELECT id FROM agents WHERE sort_order IS NULL ORDER BY is_boss DESC, pinned DESC, created_at").all() as any[])
    db.prepare("UPDATE agents SET sort_order = ? WHERE id = ?").run(++i, r.id);
}
try { db.exec("ALTER TABLE credential_requests ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE credential_requests ADD COLUMN resume TEXT"); } catch {}
// 봇 아바타를 선형 얼굴 시드로 통일 — 기존 이모지 아바타도 전환
db.exec("UPDATE agents SET avatar = 'face:' || id WHERE avatar IS NULL OR avatar NOT LIKE 'face:%'");
// CEO 봇이 하나도 없으면 기존 대장을 CEO로 승격
db.exec("UPDATE agents SET is_boss = 1 WHERE name = '대장' AND NOT EXISTS (SELECT 1 FROM agents WHERE is_boss = 1)");

export function getSetting(key: string): string | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export const uid = () => crypto.randomUUID().replaceAll("-", "").slice(0, 16);
export const now = () => Date.now();

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

-- 자격증명 사용 감사 — 어느 봇이 언제 어떤 사이트 계정을 썼는지 결과와 함께 남긴다.
-- 비밀번호 값은 절대 기록하지 않는다 (사이트명·URL·봇·결과만).
CREATE TABLE IF NOT EXISTS credential_uses (
  id TEXT PRIMARY KEY,
  site_name TEXT NOT NULL,
  url TEXT,
  agent_id TEXT,
  run_id TEXT,
  action TEXT NOT NULL,          -- autofill | request_fulfilled | request_dismissed
  outcome TEXT NOT NULL,         -- ok | failed | handoff | done | dismissed
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
  execution_context TEXT,
  execution_owner TEXT,
  execution_decision TEXT,
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
-- 사용자 명령 단위 전달 원장. 중간 실행과 외부 채널 전달을 root job 아래 묶는다.
CREATE TABLE IF NOT EXISTS command_jobs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  conversation_id TEXT,
  assistant_message_id TEXT,
  request TEXT NOT NULL DEFAULT '',
  owner_agent_id TEXT,
  execution_done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  full_result TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS command_deliveries (
  root_job_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  target TEXT,
  status TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(root_job_id, channel)
);
CREATE TABLE IF NOT EXISTS command_job_results (
  root_job_id TEXT NOT NULL,
  result_key TEXT NOT NULL,
  agent_id TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(root_job_id, result_key)
);
CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL
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
try { db.exec("ALTER TABLE approval_requests ADD COLUMN chain TEXT"); } catch {} // 요청 봇의 위임 사슬 — 승인 재개 완료 시 상위 봇에게 결과 회신용
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
try { db.exec("ALTER TABLE agents ADD COLUMN special_role TEXT"); } catch {} // 'org_admin'(Eggbot, 봇 관리 전담)
// 조직 역할 자동 배정 — 이름 기준 1회 백필 (Eggbot=조직관리)
// 역할이 이미 배정돼 있으면 백필하지 않음 — Eggbot 개명 후 새 "Eggbot"이 org_admin을 얻는 중복을 차단
db.exec("UPDATE agents SET special_role = 'org_admin' WHERE name = 'Eggbot' AND special_role IS NULL AND NOT EXISTS (SELECT 1 FROM agents WHERE special_role = 'org_admin')");
// 비서실장(secretary) 역할 폐지(2026-09-18) — CEO가 팀장·전문 봇에게 직접 배정한다. 남은 표시는 일반 봇으로 되돌림
db.exec("UPDATE agents SET special_role = NULL WHERE special_role = 'secretary'");
// 업무 트리 무결성 — 최대 2단계(CEO→팀장→봇). 잘못된 배정은 기동 시 자동 복구:
// ① 특수 역할 봇(Eggbot)은 항상 CEO 직속 ② 팀장도 CEO 직속
// ③ parent는 팀장·CEO만 가능 ④ 3단계 이상 금지
db.exec("UPDATE agents SET parent_id = NULL WHERE special_role IS NOT NULL AND parent_id IS NOT NULL");
db.exec("UPDATE agents SET parent_id = NULL WHERE is_lead = 1 AND parent_id IS NOT NULL");
db.exec("UPDATE agents SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (SELECT id FROM agents WHERE is_lead = 1 OR is_boss = 1)");
db.exec("UPDATE agents SET parent_id = NULL WHERE parent_id IN (SELECT id FROM agents WHERE parent_id IS NOT NULL)");
// 삭제된 봇의 고아 세션 정리 — 봇이 사라져도 세션·메시지가 남아 무한 누적되던 문제 방지 (messages는 FK cascade)
db.exec("DELETE FROM conversations WHERE mode = 'bot' AND agent_id IS NOT NULL AND agent_id NOT IN (SELECT id FROM agents)");
{ // 정렬값 백필 — 기존 표시 순서(CEO→핀→생성순)를 유지한 채 순번 부여
  let i = (db.prepare("SELECT COALESCE(MAX(sort_order), 0) m FROM agents").get() as any).m;
  for (const r of db.prepare("SELECT id FROM agents WHERE sort_order IS NULL ORDER BY is_boss DESC, pinned DESC, created_at").all() as any[])
    db.prepare("UPDATE agents SET sort_order = ? WHERE id = ?").run(++i, r.id);
}
try { db.exec("ALTER TABLE agent_messages ADD COLUMN chain TEXT"); } catch {} // 보낸 쪽 위임·메시지 사슬(JSON 봇 id 배열) — 순환 메시지 차단용
try { db.exec("ALTER TABLE credential_requests ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE credential_requests ADD COLUMN resume TEXT"); } catch {}
try { db.exec("ALTER TABLE messages ADD COLUMN full_content TEXT"); } catch {}
try { db.exec("ALTER TABLE messages ADD COLUMN root_job_id TEXT"); } catch {}
try { db.exec("ALTER TABLE agent_runs ADD COLUMN root_job_id TEXT"); } catch {}
try { db.exec("ALTER TABLE approval_requests ADD COLUMN root_job_id TEXT"); } catch {}
export function ensureApprovalExecutionContextColumn(database: Pick<Database, "exec"> = db) {
  try { database.exec("ALTER TABLE approval_requests ADD COLUMN execution_context TEXT"); } catch {}
  try { database.exec("ALTER TABLE approval_requests ADD COLUMN execution_owner TEXT"); } catch {}
  try { database.exec("ALTER TABLE approval_requests ADD COLUMN execution_decision TEXT"); } catch {}
}
ensureApprovalExecutionContextColumn(); // 승인 당시 실행 대상·소유자·파일/브라우저 네임스페이스
try { db.exec("ALTER TABLE agent_messages ADD COLUMN root_job_id TEXT"); } catch {}
try { db.exec("ALTER TABLE messages ADD COLUMN command_status TEXT"); } catch {}
try { db.exec("ALTER TABLE command_jobs ADD COLUMN dedupe_key TEXT"); } catch {}
try { db.exec("ALTER TABLE command_jobs ADD COLUMN needs_final_aggregation INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE command_jobs ADD COLUMN target_snapshot TEXT"); } catch {}
try { db.exec("ALTER TABLE command_jobs ADD COLUMN credential_fingerprint TEXT"); } catch {}
try { db.exec("ALTER TABLE command_jobs ADD COLUMN root_result_key TEXT"); } catch {}
try { db.exec("ALTER TABLE command_jobs ADD COLUMN email_target_snapshot TEXT"); } catch {}
try { db.exec("ALTER TABLE command_jobs ADD COLUMN email_credential_fingerprint TEXT"); } catch {}
try { db.exec("ALTER TABLE command_deliveries ADD COLUMN external_message_id TEXT"); } catch {}
try { db.exec("ALTER TABLE command_deliveries ADD COLUMN target_fingerprint TEXT"); } catch {}
try { db.exec("ALTER TABLE credential_requests ADD COLUMN root_job_id TEXT"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_command_jobs_dedupe ON command_jobs(source, dedupe_key) WHERE dedupe_key IS NOT NULL"); } catch {}
// 자기개선 실험 원장 — 모든 사이클의 후보·측정·판정·적용 여부를 남긴다 (tasks/self-improvement-contract.md)
try { db.exec(`CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  cycle INTEGER NOT NULL,          -- 사이클 번호 (날짜 내 순번)
  surface TEXT NOT NULL,           -- 변경 대상 표면 id (surfaces.json)
  target TEXT,                     -- 표면 내 대상 (스킬명·봇명·파일 경로)
  candidate TEXT,                  -- 후보 요약 (diff는 candidate_path 파일로)
  candidate_path TEXT,             -- 후보 diff·본문 저장 경로
  baseline TEXT,                   -- 기준선 측정 JSON {pass, latency_ms, cost}
  result TEXT,                     -- 후보 측정 JSON {pass, latency_ms, cost}
  verdict TEXT,                    -- keep | discard | inconclusive | crash
  reason TEXT,                     -- 판정 사유
  applied INTEGER NOT NULL DEFAULT 0, -- 소유자 승인으로 실제 반영됐는지
  created_at INTEGER NOT NULL,
  finished_at INTEGER
)`); } catch {}

// 개발 인스턴스가 검증을 마친 개선 패키지 — 서비스는 저장만 하고 사용자의 버전 업데이트로만 적용된다
try { db.exec(`CREATE TABLE IF NOT EXISTS evolve_updates (
  id TEXT PRIMARY KEY,
  version INTEGER,                   -- 적용 시 부여되는 서비스 버전 번호
  payload TEXT NOT NULL,             -- 패키지 JSON {summary, measurement{baseline,candidate,verdict,reason}, ops[]}
  status TEXT NOT NULL DEFAULT 'pending', -- pending | applied | rejected | reverted
  revert TEXT,                       -- 적용 전 상태로 되돌리는 ops JSON
  restart_required INTEGER NOT NULL DEFAULT 0, -- 코드 표면 포함 — 적용·되돌리기 후 재시작 필요
  source TEXT,                       -- 출처 (개발 인스턴스 실험 id)
  created_at INTEGER NOT NULL,
  applied_at INTEGER
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_experiments_created ON experiments(created_at)"); } catch {}
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
try { db.exec("ALTER TABLE command_jobs ADD COLUMN task_mode TEXT"); } catch {} // 작업별 권한 모드 (readonly|guard|null=기본)
try { db.exec(`CREATE TABLE IF NOT EXISTS run_steers (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_run_steers_run ON run_steers(run_id, consumed_at)"); } catch {}

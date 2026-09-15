import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(import.meta.dir, "..", "data");
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, "mybot.db"), { create: true });
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

try { db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT"); } catch {}
try { db.exec("ALTER TABLE routines ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE routines ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'schedule'"); } catch {}
try { db.exec("ALTER TABLE routines ADD COLUMN email_filter TEXT"); } catch {}
try { db.exec("ALTER TABLE skills ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN group_id TEXT"); } catch {}
try { db.exec("ALTER TABLE conversations ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE memories ADD COLUMN agent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN is_boss INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE agent_runs ADD COLUMN tool_log TEXT"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN parent_id TEXT"); } catch {}
try { db.exec("ALTER TABLE agents ADD COLUMN is_lead INTEGER NOT NULL DEFAULT 0"); } catch {}
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

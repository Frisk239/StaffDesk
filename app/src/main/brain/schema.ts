/** M1 schema。新版本走 schema_migrations，禁止裸改历史。v9（M27，0051/0058）：write_queue 放开 kind CHECK 收「场景」并加 template_json 草稿列（重建走门次）。v8（0058）：workspaces 去 scenario 枚举 CHECK、scenario_brief_specs 死表退役、scenario_templates 建表（建表走本文件 CREATE TABLE IF NOT EXISTS，门次只做重建与退役）。v7 是 operations(action) 索引——只进迁移门次，不进 SCHEMA_SQL。 */
export const SCHEMA_VERSION = 9;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scenario TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('人', '组织', '项目')),
  name TEXT NOT NULL,
  note TEXT,
  workspace_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS object_relations (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT NOT NULL CHECK (path IN ('手给', '调研')),
  role TEXT CHECK (role IN ('主键', '转述')),
  workspace_id TEXT,
  unparsed INTEGER NOT NULL DEFAULT 0,
  origin_json TEXT,
  segments_json TEXT,
  content_hash TEXT,
  fetched_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_bindings (
  source_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  PRIMARY KEY (source_id, object_id)
);

CREATE TABLE IF NOT EXISTS slot_defs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('人', '组织', '项目')),
  arity TEXT NOT NULL CHECK (arity IN ('单值', '多值')),
  scenarios TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (name, kind)
);

-- 0058：场景升为数据行。内置四模板 + 「自定义」空白基线由首启种子写入（presets）。
CREATE TABLE IF NOT EXISTS scenario_templates (
  name TEXT PRIMARY KEY,
  builtin INTEGER NOT NULL DEFAULT 0,
  hint TEXT NOT NULL DEFAULT '',
  playbook TEXT NOT NULL DEFAULT '',
  brief_spec TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('成立', '过时')),
  unverified INTEGER NOT NULL DEFAULT 1,
  valid_from TEXT,
  valid_to TEXT,
  close_reason TEXT CHECK (close_reason IN ('世界已变', '从未成立', '来源删除', '对象误建')),
  source_id TEXT NOT NULL,
  span TEXT,
  source_start INTEGER,
  source_end INTEGER,
  source_locator TEXT,
  superseded_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('全局', '对象', '会话')),
  object_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('偏好', '禁写', '习惯')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- 0054：禁写结构化路三列（对象、谓词槽、归一化取值）。不加 CHECK：SQLite 不能 ALTER CHECK，
  -- 且非禁写记忆与迁移前的历史行留 NULL 合法，原句路由 text 兜住。
  banned_object_id TEXT,
  banned_predicate TEXT,
  banned_value TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('整理', '候选记忆')),
  payload TEXT NOT NULL,
  pending INTEGER NOT NULL,
  decision TEXT,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS write_queue (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('晋升', '纠正', '整理', '绑定', '批量晋升', '批量回退', '场景')),
  task_id TEXT,
  headline TEXT NOT NULL,
  evidence TEXT NOT NULL,
  claim_id TEXT,
  claim_ids TEXT,
  source_id TEXT,
  object_ids TEXT,
  target_predicate TEXT,
  outbound INTEGER,
  -- M27：kind = '场景' 的模板草稿四件套（JSON）；其余 kind 留 NULL。
  template_json TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('调研', '出简报', '再搜一轮', '周期性雷达')),
  status TEXT NOT NULL CHECK (status IN ('待启动', '进行中', '已完成', '已停止')),
  stop_reason TEXT CHECK (stop_reason IN ('手动', '触顶', '失败')),
  budget_gear TEXT CHECK (budget_gear IN ('快搜', '深挖')),
  query TEXT,
  interval_days INTEGER,
  next_due_at TEXT,
  last_run_at TEXT,
  parent_task_id TEXT,
  due_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS task_audit (
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  blocks TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload TEXT NOT NULL,
  undo_of TEXT,
  chat_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_jobs (
  id TEXT PRIMARY KEY,
  input_kind TEXT NOT NULL CHECK (input_kind IN ('text', 'url', 'file')),
  input_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('排队', '获取中', '解析中', '提交中', '完成', '失败')),
  title TEXT,
  locator TEXT,
  source_id TEXT,
  failure_kind TEXT CHECK (
    failure_kind IN (
      'invalid-input',
      'unsupported-mime',
      'too-large',
      'too-many-pages',
      'timeout',
      'fetch-failed',
      'parse-failed',
      'empty-body',
      'interrupted'
    )
  ),
  detail TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  workspace_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS certs (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  scores TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'desk', 'card')),
  text TEXT NOT NULL,
  claim_refs TEXT,
  card TEXT,
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(
  text,
  object_id UNINDEXED,
  predicate UNINDEXED,
  tokenize='trigram'
);
`;

export const FTS_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS claims_ai AFTER INSERT ON claims BEGIN
  INSERT INTO claims_fts(rowid, text, object_id, predicate)
  VALUES (NEW.rowid, NEW.text, NEW.object_id, NEW.predicate);
END;
CREATE TRIGGER IF NOT EXISTS claims_ad AFTER DELETE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, text, object_id, predicate)
  VALUES('delete', OLD.rowid, OLD.text, OLD.object_id, OLD.predicate);
END;
CREATE TRIGGER IF NOT EXISTS claims_au AFTER UPDATE ON claims BEGIN
  INSERT INTO claims_fts(claims_fts, rowid, text, object_id, predicate)
  VALUES('delete', OLD.rowid, OLD.text, OLD.object_id, OLD.predicate);
  INSERT INTO claims_fts(rowid, text, object_id, predicate)
  VALUES (NEW.rowid, NEW.text, NEW.object_id, NEW.predicate);
END;
`;

export const REQUIRED_TABLES = [
  'schema_migrations',
  'workspaces',
  'objects',
  'object_relations',
  'sources',
  'source_bindings',
  'slot_defs',
  'scenario_templates',
  'claims',
  'memories',
  'proposals',
  'write_queue',
  'tasks',
  'task_audit',
  'briefs',
  'operations',
  'ingest_jobs',
  'certs',
  'chat_messages',
  'app_meta',
] as const;

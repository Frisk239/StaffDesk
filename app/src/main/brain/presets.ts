import type Database from 'better-sqlite3';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import { metaGet, metaSet } from './persist';

const PRESET_AT = '1970-01-01T00:00:00.000Z';

// 0057：种子门是 app_meta 首启标记，不是「表空才插」——用户清空谓词表后重启，
// 不得被默认槽重新插回；既有已种子的库（表非空、无标记）只补写标记，不重复播种。
const PRESETS_SEEDED_KEY = 'presets_seeded';

// 0058：场景模板种子用独立新键——既有库的 presets_seeded 全是 '1'，
// 复用旧键会让模板种子在全部既有库上被跳过。删空模板表后重启同样不得复活。
const SCENARIO_TEMPLATES_SEEDED_KEY = 'scenario_templates_seeded';

/** 首启只写槽表预设。不写虚构对象/来源/主张。简报说明与说明书随场景模板另门播种。 */
export function seedPresets(db: Database.Database): void {
  if (metaGet(db, PRESETS_SEEDED_KEY) === '1') return;

  const slotCount = db.prepare('SELECT COUNT(*) AS n FROM slot_defs').get() as { n: number };
  if (slotCount.n === 0) {
    const insert = db.prepare(
      `INSERT INTO slot_defs (id, name, kind, arity, scenarios, created_at)
       VALUES (@id, @name, @kind, @arity, @scenarios, @created_at)`,
    );
    const tx = db.transaction(() => {
      DEFAULT_SLOT_DEFS.forEach((slot, i) => {
        insert.run({
          id: `slot-${String(i + 1).padStart(3, '0')}`,
          name: slot.name,
          kind: slot.kind,
          arity: slot.arity,
          scenarios: JSON.stringify(slot.scenarios),
          created_at: PRESET_AT,
        });
      });
    });
    tx();
  }

  metaSet(db, PRESETS_SEEDED_KEY, '1');
}

/**
 * 0058：首启种内置场景模板——四内置（求职面试/求学申请/技术选型/尽调研究）+
 * 「自定义」空白基线，全部 builtin=true。SCENARIO_HINTS / BRIEF_SPECS / DEFAULT_PLAYBOOK
 * 常量在此降级为种子源。既有库（键缺、表非空）只补键不重播；表空且键缺（异常态）播种+补键。
 */
export function seedScenarioTemplates(db: Database.Database): void {
  if (metaGet(db, SCENARIO_TEMPLATES_SEEDED_KEY) === '1') return;

  const count = db.prepare('SELECT COUNT(*) AS n FROM scenario_templates').get() as { n: number };
  if (count.n === 0) {
    const insert = db.prepare(
      `INSERT INTO scenario_templates (name, builtin, hint, playbook, brief_spec, created_at)
       VALUES (@name, @builtin, @hint, @playbook, @brief_spec, @created_at)`,
    );
    const tx = db.transaction(() => {
      for (const template of builtinScenarioTemplates()) {
        insert.run({
          name: template.name,
          builtin: 1,
          hint: template.hint,
          playbook: template.playbook,
          brief_spec: JSON.stringify(template.briefSpec),
          created_at: PRESET_AT,
        });
      }
    });
    tx();
  }

  metaSet(db, SCENARIO_TEMPLATES_SEEDED_KEY, '1');
}

export function listSlotDefs(db: Database.Database): typeof DEFAULT_SLOT_DEFS {
  const rows = db
    .prepare('SELECT name, kind, arity, scenarios FROM slot_defs ORDER BY created_at, id')
    .all() as { name: string; kind: string; arity: string; scenarios: string }[];
  return rows.map((r) => ({
    name: r.name,
    kind: r.kind as (typeof DEFAULT_SLOT_DEFS)[number]['kind'],
    arity: r.arity as (typeof DEFAULT_SLOT_DEFS)[number]['arity'],
    scenarios: JSON.parse(r.scenarios) as (typeof DEFAULT_SLOT_DEFS)[number]['scenarios'],
  }));
}

import type Database from 'better-sqlite3';
import { BRIEF_SPECS, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import type { BriefSpecBlock, ScenarioKind } from '@shared/types';

const PRESET_AT = '1970-01-01T00:00:00.000Z';

/** 首启只写场景预设包：槽表 + 简报说明。不写虚构对象/来源/主张。 */
export function seedPresets(db: Database.Database): void {
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

  const specCount = db.prepare('SELECT COUNT(*) AS n FROM scenario_brief_specs').get() as {
    n: number;
  };
  if (specCount.n === 0) {
    const insert = db.prepare(
      `INSERT INTO scenario_brief_specs (scenario, spec) VALUES (@scenario, @spec)`,
    );
    const tx = db.transaction(() => {
      (Object.keys(BRIEF_SPECS) as ScenarioKind[]).forEach((scenario) => {
        insert.run({ scenario, spec: JSON.stringify(BRIEF_SPECS[scenario]) });
      });
    });
    tx();
  }
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

export function listBriefSpecs(db: Database.Database): Record<ScenarioKind, BriefSpecBlock[]> {
  const rows = db.prepare('SELECT scenario, spec FROM scenario_brief_specs').all() as {
    scenario: ScenarioKind;
    spec: string;
  }[];
  const out = { ...BRIEF_SPECS };
  for (const row of rows) {
    out[row.scenario] = JSON.parse(row.spec) as BriefSpecBlock[];
  }
  return out;
}

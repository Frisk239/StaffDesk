import type { Action } from '@shared/actions';
import type {
  BriefBlockKind,
  BriefSpecBlock,
  ObjectKind,
  Predicate,
  Proposal,
  ScenarioKind,
  ScenarioTemplate,
  State,
  WriteProposal,
} from '@shared/types';
import { deriveConflicts } from '@shared/scenario';
import { claimBelongsToSlotKind } from './actionHelpers';

// 槽与模板域 reducer 分支：受控谓词表与场景模板的增删改及其四处置级联（0025/0057/0058）。

/** 0057：槽改名/删除后，指向旧名的挂起整理（含编目）提议会变确认必报错的死卡——
 *  一并撤下（pending:false, decision:'reject'），照 DELETE_OBJECT 撤提议的匹配面。 */
function withdrawTidyProposalsAbout(
  state: State,
  oldName: Predicate,
  kind: ObjectKind,
): Proposal[] {
  return state.proposals.map((p) => {
    const payload = p.payload;
    // 判别收窄落到 const：直接在 p.payload 上链式判别会让 TS 丢失窄化。
    if (!p.pending || payload.kind !== '整理') return p;
    const claim = state.claims.find((c) => c.id === payload.claimId);
    const touches =
      payload.targetPredicate === oldName ||
      (claim !== undefined &&
        claim.predicate === oldName &&
        claimBelongsToSlotKind(state, claim.objectId, kind));
    return touches ? { ...p, pending: false, decision: 'reject' as const } : p;
  });
}

function sameScenarios(a: ScenarioKind[], b: ScenarioKind[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s));
}

// F2（审计 2026-09-01，0051/0057）：槽改名/删除的级联面要含挂起的「整理」写卡——写队列也是账本状态。
// 行不记槽种类，按其主张归属对象的种类判分区（对齐 claimBelongsToSlotKind；主张不在场时跟随槽名走）。
// 改名让 targetPredicate 跟随（确认时落新谓词）；删除把行直接撤下——它们是待确认写卡不是提议，
// 槽没了就是确认必报错的死卡，从队列移除即消灭。
function tidyWriteTouchesSlot(
  state: State,
  write: WriteProposal,
  name: Predicate,
  kind: ObjectKind,
): boolean {
  if (write.kind !== '整理' || write.targetPredicate !== name) return false;
  const claim = write.claimId ? state.claims.find((c) => c.id === write.claimId) : undefined;
  if (!claim) return true;
  return claimBelongsToSlotKind(state, claim.objectId, kind);
}

function renameTidyWriteQueue(
  state: State,
  oldName: Predicate,
  newName: Predicate,
  kind: ObjectKind,
): WriteProposal[] {
  return state.writeQueue.map((w) =>
    tidyWriteTouchesSlot(state, w, oldName, kind) ? { ...w, targetPredicate: newName } : w,
  );
}

function dropTidyWriteQueue(state: State, name: Predicate, kind: ObjectKind): WriteProposal[] {
  return state.writeQueue.filter((w) => !tidyWriteTouchesSlot(state, w, name, kind));
}

// 0058：场景模板的简报说明块约束。IPC 边界送来的 JSON 不受 TS 类型保护，运行时必须自校验。
const BRIEF_BLOCK_KINDS = new Set<BriefBlockKind>(['background', 'slots', 'synthesis', 'gaps']);

/** 0058：入库前归一——标题去空白、谓词数组复制（可选字段缺省原样缺省），不改变块语义。 */
function normalizeBriefSpecBlock(block: BriefSpecBlock): BriefSpecBlock {
  const normalized: BriefSpecBlock = { title: block.title.trim(), kind: block.kind };
  if (block.predicates) normalized.predicates = [...block.predicates];
  return normalized;
}

/** 0058：槽改名级联——全部模板 briefSpec 的 predicates 旧名→新名同步重写（保护解除改级联改写）。 */
function rewriteTemplatesPredicate(
  templates: ScenarioTemplate[],
  oldName: Predicate,
  newName: Predicate,
): ScenarioTemplate[] {
  return templates.map((t) => ({
    ...t,
    briefSpec: t.briefSpec.map((block) =>
      block.predicates?.includes(oldName)
        ? {
            ...block,
            predicates: block.predicates.map((p) => (p === oldName ? newName : p)),
          }
        : block,
    ),
  }));
}

/**
 * 0058：删槽级联——块内剔除该谓词；slots 块谓词清空则整块撤下（空谓词的槽块只会永远渲染未知）。
 * 返回改写后的模板集与被撤下的块数（toast 附注用）。
 */
function dropTemplatesPredicate(
  templates: ScenarioTemplate[],
  name: Predicate,
): { templates: ScenarioTemplate[]; withdrawnBlocks: number } {
  let withdrawnBlocks = 0;
  const next = templates.map((t) => {
    const briefSpec: BriefSpecBlock[] = [];
    for (const block of t.briefSpec) {
      if (!block.predicates?.includes(name)) {
        briefSpec.push(block);
        continue;
      }
      const predicates = block.predicates.filter((p) => p !== name);
      if (predicates.length === 0) {
        withdrawnBlocks += 1;
        continue;
      }
      briefSpec.push({ ...block, predicates });
    }
    return { ...t, briefSpec };
  });
  return { templates: next, withdrawnBlocks };
}

/**
 * 0058：场景模板 UPSERT 的校验+写入体（M27 起 CONFIRM_WRITE 的场景分支共用——
 * reducer 内不能嵌套 dispatch，提取为纯 helper）。ok:false 时 state 只带 toast，
 * 调用方决定是否保留写队列行。
 */
export function applyScenarioTemplateUpsert(
  state: State,
  template: ScenarioTemplate,
  previousName?: string | undefined,
): { ok: boolean; state: State } {
  // 0058：模板编辑是人手设置动作，直接改账本、不进撤销卡（0057 口径）；operations 自动留痕。
  // builtin 标记按 existing 行裁定：内置可改内容不可改名（回落锚点按名字寻址），
  // 人不可自封内置；新模板一律 builtin=false。
  const name = template.name.trim();
  const prev = (previousName ?? '').trim() || name;
  if (!name) {
    return {
      ok: false,
      state: { ...state, toast: { text: '模板名不能为空', id: state.seq }, seq: state.seq + 1 },
    };
  }
  const previous = state.scenarioTemplates.find((t) => t.name === prev);
  const renaming = prev !== name;
  if (renaming) {
    if (previous?.builtin) {
      return {
        ok: false,
        state: {
          ...state,
          toast: { text: '内置模板不能改名，只能编辑内容', id: state.seq },
          seq: state.seq + 1,
        },
      };
    }
    if (state.scenarioTemplates.some((t) => t.name === name)) {
      return {
        ok: false,
        state: {
          ...state,
          toast: { text: `已有同名场景模板「${name}」`, id: state.seq },
          seq: state.seq + 1,
        },
      };
    }
  } else if (!previous && template.builtin) {
    return {
      ok: false,
      state: {
        ...state,
        toast: { text: '内置模板只随首启种子写入，不能手工新建', id: state.seq },
        seq: state.seq + 1,
      },
    };
  }
  for (const block of template.briefSpec) {
    if (!block.title.trim()) {
      return {
        ok: false,
        state: {
          ...state,
          toast: { text: '简报说明块的标题不能为空', id: state.seq },
          seq: state.seq + 1,
        },
      };
    }
    if (!BRIEF_BLOCK_KINDS.has(block.kind)) {
      return {
        ok: false,
        state: {
          ...state,
          toast: { text: `简报说明块的类型不合法：${String(block.kind)}`, id: state.seq },
          seq: state.seq + 1,
        },
      };
    }
  }
  // 0025：briefSpec 只能引用受控谓词表内既有槽名，不许自开槽（照现状口径不按种类加严）。
  const slotNames = new Set(state.slotDefs.map((d) => d.name));
  for (const block of template.briefSpec) {
    for (const predicate of block.predicates ?? []) {
      if (!slotNames.has(predicate)) {
        return {
          ok: false,
          state: {
            ...state,
            toast: {
              text: `简报说明引用了表外字段「${predicate}」，请先在谓词表建槽`,
              id: state.seq,
            },
            seq: state.seq + 1,
          },
        };
      }
    }
  }
  const next: ScenarioTemplate = {
    name,
    builtin: previous ? previous.builtin : false,
    hint: template.hint.trim(),
    playbook: template.playbook.trim(),
    briefSpec: template.briefSpec.map(normalizeBriefSpecBlock),
  };
  const scenarioTemplates = previous
    ? state.scenarioTemplates.map((t) => (t.name === prev ? next : t))
    : [...state.scenarioTemplates, next];
  // 改自定义模板名级联两处引用（0058，对齐 UPDATE_SLOT 改名级联纪律，不留悬挂引用）：
  // workspaces.scenario 与 slot_defs.scenarios 都按模板名匹配。
  const workspaces = renaming
    ? state.workspaces.map((w) => (w.scenario === prev ? { ...w, scenario: name } : w))
    : state.workspaces;
  const slotDefs = renaming
    ? state.slotDefs.map((d) =>
        d.scenarios.includes(prev)
          ? { ...d, scenarios: d.scenarios.map((s) => (s === prev ? name : s)) }
          : d,
      )
    : state.slotDefs;
  return {
    ok: true,
    state: {
      ...state,
      seq: state.seq + 1,
      scenarioTemplates,
      workspaces,
      slotDefs,
      toast: {
        text: renaming
          ? `已改名场景模板「${prev}」→「${name}」`
          : previous
            ? `已保存场景模板「${name}」`
            : `已新建场景模板「${name}」`,
        id: state.seq + 1,
      },
    },
  };
}

export function slotTemplateActions(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'UPSERT_SCENARIO_TEMPLATE':
      // 0058：校验+写入体提取为 applyScenarioTemplateUpsert（M27 起与 CONFIRM_WRITE 场景分支共用）。
      return applyScenarioTemplateUpsert(state, action.template, action.previousName).state;

    case 'REMOVE_SCENARIO_TEMPLATE': {
      // 0058：内置模板（四内置 + 「自定义」基线）禁删——回落语义的锚点按名字寻址；
      // 被工作区引用一律拒绝（先移除或改区再删）。
      const name = action.name.trim();
      const template = state.scenarioTemplates.find((t) => t.name === name);
      if (!template) {
        return {
          ...state,
          toast: { text: '没有这个场景模板', id: state.seq },
          seq: state.seq + 1,
        };
      }
      if (template.builtin) {
        return {
          ...state,
          toast: { text: '内置模板不能删除', id: state.seq },
          seq: state.seq + 1,
        };
      }
      const referencing = state.workspaces.filter((w) => w.scenario === name);
      if (referencing.length > 0) {
        return {
          ...state,
          toast: {
            text: `有 ${referencing.length} 个工作区正在使用「${name}」，先移除或改区再删`,
            id: state.seq,
          },
          seq: state.seq + 1,
        };
      }
      // F1（审计 2026-09-01）：删除级联——各槽 scenarios 数组中的该模板名一并剔除（对齐改名级联，
      // 不留悬挂引用：悬挂名会让槽在 slotsForScene 下永不匹配、从对象页静默消失）；
      // 数组剔空的槽即退化为通用（全场景显示）。
      let cascadedSlots = 0;
      const slotDefs = state.slotDefs.map((d) => {
        if (!d.scenarios.includes(name)) return d;
        cascadedSlots += 1;
        return { ...d, scenarios: d.scenarios.filter((s) => s !== name) };
      });
      return {
        ...state,
        seq: state.seq + 1,
        scenarioTemplates: state.scenarioTemplates.filter((t) => t.name !== name),
        slotDefs,
        toast: {
          text:
            cascadedSlots > 0
              ? `已删除场景模板「${name}」，并从 ${cascadedSlots} 个字段的场景适用中移除`
              : `已删除场景模板「${name}」`,
          id: state.seq + 1,
        },
      };
    }

    case 'ADD_SLOT': {
      // 0025：谓词表由人维护。新槽默认通用（所有场景显示），单值/多值影响冲突判定（0029）。
      const name = action.name.trim();
      if (!name)
        return { ...state, toast: { text: '槽名不能为空', id: state.seq }, seq: state.seq + 1 };
      if (name === '未编目') {
        return {
          ...state,
          toast: { text: '「未编目」是保留值', id: state.seq },
          seq: state.seq + 1,
        };
      }
      if (state.slotDefs.some((d) => d.name === name && d.kind === action.kind)) {
        return {
          ...state,
          toast: { text: '该种类下已有同名槽', id: state.seq },
          seq: state.seq + 1,
        };
      }
      return {
        ...state,
        seq: state.seq + 1,
        slotDefs: [
          ...state.slotDefs,
          { name, kind: action.kind, arity: action.arity, scenarios: [] },
        ],
        toast: { text: `已加槽「${name}」（通用）`, id: state.seq + 1 },
      };
    }

    case 'UPDATE_SLOT': {
      // 0057：槽编辑是人手设置动作，直接改账本、不进撤销卡——operations 每行留痕，
      // 改名可再改回。守卫：新名非空、非「未编目」、(名,种类) 不撞库内 UNIQUE。
      // 0058：M25「被内置简报说明引用禁改名」保护解除——场景模板已数据化，
      // 改名改为级联重写各模板 briefSpec 的谓词名（见尾部），不再有常量失配。
      const slot = state.slotDefs.find((d) => d.name === action.name && d.kind === action.kind);
      if (!slot) {
        return { ...state, toast: { text: '没有这个槽', id: state.seq }, seq: state.seq + 1 };
      }
      const nextName = action.next.name === undefined ? undefined : action.next.name.trim();
      const renaming = nextName !== undefined && nextName !== slot.name;
      if (renaming && nextName !== undefined) {
        if (!nextName)
          return { ...state, toast: { text: '槽名不能为空', id: state.seq }, seq: state.seq + 1 };
        if (nextName === '未编目') {
          return {
            ...state,
            toast: { text: '「未编目」是保留值', id: state.seq },
            seq: state.seq + 1,
          };
        }
        if (state.slotDefs.some((d) => d.name === nextName && d.kind === action.kind)) {
          return {
            ...state,
            toast: { text: '该种类下已有同名槽', id: state.seq },
            seq: state.seq + 1,
          };
        }
      }
      const nextArity = action.next.arity ?? slot.arity;
      const nextScenarios = action.next.scenarios ?? slot.scenarios;
      // 全缺省（或无实际变化）→ 原样返回，不空跑 toast、不弄脏 persist 判脏引用。
      if (!renaming && nextArity === slot.arity && sameScenarios(nextScenarios, slot.scenarios)) {
        return state;
      }
      const effectiveName = renaming && nextName !== undefined ? nextName : slot.name;
      // 级联三处（0057）：槽行；该槽主张 predicate 同步重写（投影/冲突派生/简报槽块都以槽名为键）；
      // 禁写结构化谓词列（0054 bannedPredicate）同步重写——不同步则禁写的槽匹配静默失效。
      const claims = renaming
        ? state.claims.map((c) =>
            c.predicate === slot.name && claimBelongsToSlotKind(state, c.objectId, action.kind)
              ? { ...c, predicate: effectiveName }
              : c,
          )
        : state.claims;
      const memories = renaming
        ? state.memories.map((m) => {
            if (m.bannedPredicate !== slot.name) return m;
            if (m.bannedObjectId && !claimBelongsToSlotKind(state, m.bannedObjectId, action.kind)) {
              return m;
            }
            return { ...m, bannedPredicate: effectiveName };
          })
        : state.memories;
      const proposals = renaming
        ? withdrawTidyProposalsAbout(state, slot.name, action.kind)
        : state.proposals;
      // F2：挂起的「整理」写卡 targetPredicate 跟随改名，确认时落新谓词。
      const writeQueue = renaming
        ? renameTidyWriteQueue(state, slot.name, effectiveName, action.kind)
        : state.writeQueue;
      const slotDefs = state.slotDefs.map((d) =>
        d.name === slot.name && d.kind === action.kind
          ? { ...d, name: effectiveName, arity: nextArity, scenarios: nextScenarios }
          : d,
      );
      // 0058：级联第四处——全部模板 briefSpec 的谓词旧名→新名重写（简报槽块以谓词名为键）。
      const scenarioTemplates = renaming
        ? rewriteTemplatesPredicate(state.scenarioTemplates, slot.name, effectiveName)
        : state.scenarioTemplates;
      // arity 多值→单值是 0029 的合法派生：告知将产生的冲突处数，由人按关窗纪律消解，
      // 系统不自动关任何主张（deriveConflicts 读改后账本即时生效）。
      const parts: string[] = [];
      if (renaming) parts.push(`已改名「${slot.name}」→「${effectiveName}」`);
      if (slot.arity === '多值' && nextArity === '单值') {
        const pairs = deriveConflicts(claims, slotDefs).filter((pair) => {
          const a = claims.find((c) => c.id === pair.claimIdA);
          const b = claims.find((c) => c.id === pair.claimIdB);
          return a?.predicate === effectiveName && b?.predicate === effectiveName;
        });
        parts.push(
          pairs.length > 0 ? `已切换为单值：标记 ${pairs.length} 处冲突待消解` : '已切换为单值',
        );
      } else if (nextArity !== slot.arity) {
        parts.push('已切换为多值');
      }
      if (!sameScenarios(nextScenarios, slot.scenarios)) parts.push('场景适用已更新');
      return {
        ...state,
        seq: state.seq + 1,
        slotDefs,
        claims,
        memories,
        proposals,
        writeQueue,
        scenarioTemplates,
        toast: { text: parts.join('，'), id: state.seq + 1 },
      };
    }

    case 'REMOVE_SLOT': {
      // 0057：删除级联——该槽成立主张降为「未编目」，自动获得抽取映射不上的全套既有语义
      // （不建冲突 0037、简报降级「材料提到·不作定论」、整理出编目卡）；已关窗主张保留旧名作历史。
      // 0058：M25「被内置简报说明引用禁删」保护解除——改为从各模板 briefSpec 块内剔除该谓词，
      // slots 块谓词清空则整块撤下并 toast 说明。
      const slot = state.slotDefs.find((d) => d.name === action.name && d.kind === action.kind);
      if (!slot) {
        return { ...state, toast: { text: '没有这个槽', id: state.seq }, seq: state.seq + 1 };
      }
      let demoted = 0;
      const claims = state.claims.map((c) => {
        if (
          c.predicate !== slot.name ||
          c.status !== '成立' ||
          !claimBelongsToSlotKind(state, c.objectId, action.kind)
        ) {
          return c;
        }
        demoted += 1;
        return { ...c, predicate: '未编目' };
      });
      const proposals = withdrawTidyProposalsAbout(state, slot.name, action.kind);
      // F2：删槽把指向该槽的挂起「整理」写卡一并撤下，不留确认必报错的死卡。
      const writeQueue = dropTidyWriteQueue(state, slot.name, action.kind);
      const { templates: scenarioTemplates, withdrawnBlocks } = dropTemplatesPredicate(
        state.scenarioTemplates,
        slot.name,
      );
      const parts: string[] = [
        demoted > 0
          ? `已删除槽「${slot.name}」：${demoted} 条主张转入未编目`
          : `已删除槽「${slot.name}」`,
      ];
      if (withdrawnBlocks > 0) parts.push(`并从简报说明撤下 ${withdrawnBlocks} 个空块`);
      return {
        ...state,
        seq: state.seq + 1,
        slotDefs: state.slotDefs.filter((d) => !(d.name === slot.name && d.kind === action.kind)),
        claims,
        proposals,
        writeQueue,
        scenarioTemplates,
        toast: { text: parts.join('，'), id: state.seq + 1 },
      };
    }

    default:
      return undefined;
  }
}

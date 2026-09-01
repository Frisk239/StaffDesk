import { z } from 'zod';
import { parseScenarioDraftIntent } from '@shared/chat';
import { CUSTOM_BASELINE_PLAYBOOK } from '@shared/playbook';
import type { BriefSpecBlock, ScenarioTemplate, State } from '@shared/types';
import type { ModelCompletion } from '../llm/runtime';
import { safeDetail } from '../redact';

// M27：场景模板起草循环——只产草稿，不碰 brain 写路径。
// 模型一次结构化调用给出四件套；简报块谓词只允许引用受控表现有槽（0025），
// normalize 阶段过滤表外谓词（宁可少不可编），确认时的 UPSERT 守卫仍是最后防线。

const DraftSchema = z.object({
  name: z.string(),
  hint: z.string().default(''),
  playbook: z.string().default(''),
  blocks: z
    .array(
      z.object({
        title: z.string(),
        kind: z.enum(['background', 'slots', 'synthesis', 'gaps']),
        predicates: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});

type DraftShape = z.infer<typeof DraftSchema>;

export type ScenarioDraftResult =
  | { status: 'success'; template: ScenarioTemplate }
  | { status: 'unconfigured' | 'invalid-output' | 'failed'; detail?: string | undefined };

export async function draftScenarioTemplate(args: {
  state: State;
  userText: string;
  complete?: ModelCompletion | undefined;
}): Promise<ScenarioDraftResult> {
  if (!args.complete) {
    return { status: 'unconfigured', detail: '起草场景需要先在设置里配置模型' };
  }
  const slotNames = args.state.slotDefs.map((d) => d.name);
  const slotLine = slotNames.length
    ? `简报块的谓词只能从下面的字段清单里选，清单之外的不许出现：${slotNames.join('、')}`
    : '当前谓词表没有字段，简报块不要用 slots 类型';
  const intent = parseScenarioDraftIntent(args.userText);
  const existingNames = args.state.scenarioTemplates.map((t) => t.name);
  try {
    const result = await args.complete({
      jsonMode: true,
      messages: [
        {
          role: 'system',
          content: [
            '你是 StaffDesk 的场景模板起草器：按使用者的要求起草一个场景模板草稿，供人确认后创建。',
            '草稿只描述这个场景下的工作方法（盯什么、简报怎么装），不编造任何对象事实。',
            '说明书按行写要求，必须包含这三条纪律：',
            ...CUSTOM_BASELINE_PLAYBOOK.split('\n').map((line) => `- ${line}`),
            slotLine,
            'blocks 的 kind 只能是 background、slots、synthesis、gaps；只有 slots 块给 predicates。',
            existingNames.length ? `已有场景模板不要重名：${existingNames.join('、')}` : '',
            '只输出 JSON：{"name":"场景名","hint":"建对象引导一句话","playbook":"说明书多行文本",',
            '"blocks":[{"title":"块标题","kind":"background|slots|synthesis|gaps","predicates":["字段名"]}]}',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        },
        {
          role: 'user',
          content: [
            intent?.name
              ? `使用者点名的场景名：「${intent.name}」，没有更贴切的名字就直接用它。`
              : '',
            `起草要求：${args.userText}`,
          ]
            .filter((line) => line !== '')
            .join('\n'),
        },
      ],
    });
    const parsed = parseDraft(result.content);
    if (!parsed.ok) return { status: 'invalid-output', detail: parsed.detail };
    return draftToTemplate(parsed.draft, slotNames);
  } catch (error) {
    return { status: 'failed', detail: safeDetail(error) };
  }
}

/** 宁可少不可编：表外谓词剔除、去重；slots 块谓词剔空则整块弃（空谓词槽块只会永远渲染未知）。 */
function draftToTemplate(draft: DraftShape, slotNames: string[]): ScenarioDraftResult {
  const name = draft.name.trim();
  if (!name) return { status: 'invalid-output', detail: '模型没有给出场景名' };
  const controlled = new Set(slotNames);
  const briefSpec: BriefSpecBlock[] = [];
  for (const block of draft.blocks) {
    const title = block.title.trim();
    if (!title) continue;
    const predicates = [...new Set(block.predicates.map((p) => p.trim()))].filter((p) =>
      controlled.has(p),
    );
    if (block.kind === 'slots' && predicates.length === 0) continue;
    const normalized: BriefSpecBlock =
      block.kind === 'slots'
        ? { title, kind: block.kind, predicates }
        : { title, kind: block.kind };
    briefSpec.push(normalized);
  }
  return {
    status: 'success',
    template: {
      name,
      builtin: false, // M27：起草产物恒为自定义模板，人不可自封内置（0058）
      hint: draft.hint.trim(),
      playbook: draft.playbook.trim(),
      briefSpec,
    },
  };
}

function parseDraft(
  content: string,
): { ok: true; draft: DraftShape } | { ok: false; detail: string } {
  const trimmed = content.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return { ok: false, detail: '模型返回了空内容' };
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  const sliced =
    firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : '';
  const candidates = [trimmed, fenced, sliced].filter((candidate): candidate is string =>
    Boolean(candidate),
  );
  let sawJson = false;
  for (const candidate of candidates) {
    try {
      const json: unknown = JSON.parse(candidate);
      sawJson = true;
      const parsed = DraftSchema.safeParse(json);
      if (parsed.success) return { ok: true, draft: parsed.data };
    } catch {
      // 继续尝试安全截取。
    }
  }
  return {
    ok: false,
    detail: sawJson ? '模型返回的 JSON 不符合场景模板草稿结构' : '模型没有返回可解析的 JSON',
  };
}

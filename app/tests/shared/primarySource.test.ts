import { describe, expect, it } from 'vitest';
import { emptyUiFields } from '@shared/defaults';
import { builtinScenarioTemplates, DEFAULT_SLOT_DEFS } from '@shared/scenario';
import {
  bindingRole,
  objectOfficialHostnames,
  primaryBackedClaimsNoLongerLive,
  shouldSuggestPrimary,
  sourceHostname,
  withBindingRole,
} from '@shared/primarySource';
import type { Claim, DeskObject, Source, State } from '@shared/types';

function sourceOf(partial: Partial<Source> & Pick<Source, 'id' | 'title'>): Source {
  return {
    body: '',
    path: '手给',
    boundObjectIds: [],
    ...partial,
  };
}

function objectOf(partial: Partial<DeskObject> & Pick<DeskObject, 'id' | 'name'>): DeskObject {
  return { kind: '组织', relationIds: [], workspaceId: 'ws', ...partial };
}

describe('主键域名启发 0062', () => {
  it('只从来源 URL 与本身是链接的标题取域名，剥掉 www', () => {
    expect(
      sourceHostname(
        sourceOf({
          id: 's1',
          title: '摘录',
          origin: { kind: 'url', finalUrl: 'https://www.zhanqiao.dev/about' },
        }),
      ),
    ).toBe('zhanqiao.dev');
    expect(sourceHostname(sourceOf({ id: 's2', title: 'https://docs.zhanqiao.dev/jd' }))).toBe(
      'docs.zhanqiao.dev',
    );
    expect(sourceHostname(sourceOf({ id: 's3', title: '栈桥科技官网摘录' }))).toBeNull();
  });

  it('对象线索只收名字即域名、备注链接、成立主张里的链接，不用名称子串撞二级域', () => {
    const object = objectOf({ id: 'o1', name: 'Go', note: '官网 https://zhanqiao.dev' });
    const claims: Claim[] = [
      {
        id: 'c1',
        objectId: 'o1',
        predicate: '主营业务',
        text: '主页见 https://careers.zhanqiao.dev/jobs',
        status: '成立',
        unverified: false,
        sourceId: 's',
        createdAt: '2026-09-01',
      },
    ];
    expect(objectOfficialHostnames(object, claims).sort()).toEqual(
      ['careers.zhanqiao.dev', 'zhanqiao.dev'].sort(),
    );
    expect(
      shouldSuggestPrimary(
        sourceOf({
          id: 's',
          title: '材料',
          origin: { kind: 'url', finalUrl: 'https://go.dev/blog' },
        }),
        object,
        claims,
      ),
    ).toBe(false);
  });

  it('来源域名与对象官网一致才建议，子域不一致不建议', () => {
    const object = objectOf({ id: 'o1', name: 'zhanqiao.dev' });
    const claims: Claim[] = [];
    expect(
      shouldSuggestPrimary(
        sourceOf({
          id: 's',
          title: '材料',
          origin: { kind: 'url', locator: 'https://zhanqiao.dev/about' },
        }),
        object,
        claims,
      ),
    ).toBe(true);
    expect(
      shouldSuggestPrimary(
        sourceOf({
          id: 's2',
          title: '媒体',
          origin: { kind: 'url', finalUrl: 'https://news.example.com/zhanqiao' },
        }),
        object,
        claims,
      ),
    ).toBe(false);
  });
});

describe('绑定级角色 0062', () => {
  it('缺省转述，只记录显式主键，同一来源对不同对象可不同', () => {
    const base = sourceOf({ id: 's', title: '同一 URL', boundObjectIds: ['a', 'b'] });
    expect(bindingRole(base, 'a')).toBe('转述');
    const marked = withBindingRole(base, 'a', '主键');
    expect(bindingRole(marked, 'a')).toBe('主键');
    expect(bindingRole(marked, 'b')).toBe('转述');
    const reverted = withBindingRole(marked, 'a', '转述');
    expect(reverted.bindingRoles).toBeUndefined();
  });
});

describe('转述不得关窗主键 0062', () => {
  it('自动路径若把主键背书的成立主张变成过时，守护函数能抓到', () => {
    const source: Source = sourceOf({
      id: 's-primary',
      title: '官网',
      boundObjectIds: ['o1'],
      bindingRoles: { o1: '主键' },
    });
    const claim: Claim = {
      id: 'c1',
      objectId: 'o1',
      predicate: '后端主栈',
      text: '主栈是 Go',
      status: '成立',
      unverified: false,
      sourceId: 's-primary',
      createdAt: '2026-01-01',
    };
    const prev: State = {
      ...emptyUiFields(),
      workspaces: [{ id: 'ws', name: '区', scenario: '求职面试' }],
      currentWorkspaceId: 'ws',
      objects: [objectOf({ id: 'o1', name: '甲' })],
      sources: [source],
      claims: [claim],
      slotDefs: DEFAULT_SLOT_DEFS,
      scenarioTemplates: builtinScenarioTemplates(),
      briefs: [],
      memories: [],
      inbox: [],
      proposals: [],
      tasks: [],
      taskAudits: [],
      chatByObject: {},
      seq: 1,
      onboardingDone: true,
    };
    const next: State = {
      ...prev,
      claims: [{ ...claim, status: '过时', closeReason: '世界已变', validTo: '2026-09-01' }],
    };
    expect(primaryBackedClaimsNoLongerLive(prev, next).map((c) => c.id)).toEqual(['c1']);
    expect(primaryBackedClaimsNoLongerLive(prev, prev)).toEqual([]);
  });
});

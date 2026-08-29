import { createContext, useCallback, useContext, useEffect, useState, type Dispatch, type ReactNode } from 'react';
import type { Action } from '@shared/actions';
import type { Claim, RightTab, State } from '@shared/types';
import { deriveConflicts } from '@shared/scenario';

// 渲染层只做展示与发起。账本规则在主进程 brain，不在这里再实现一遍。

const StoreContext = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    void window.staffdesk.snapshot().then(setState);
    return window.staffdesk.onStateChanged(setState);
  }, []);

  const dispatch = useCallback((action: Action) => {
    void window.staffdesk.dispatch(action).then(setState);
  }, []);

  if (!state) {
    return (
      <div className="desktop">
        <div className="window" style={{ padding: 24 }}>
          加载中…
        </div>
      </div>
    );
  }

  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}

export function projectionClaims(state: State, objectId: string): Claim[] {
  const bound = new Set(
    state.sources.filter((s) => s.boundObjectIds.includes(objectId)).map((s) => s.id),
  );
  bound.add('user-stmt');
  return state.claims.filter(
    (c) => c.objectId === objectId && c.status !== '过时' && bound.has(c.sourceId),
  );
}

export function closedClaims(state: State, objectId: string): Claim[] {
  return state.claims.filter((c) => c.objectId === objectId && c.status === '过时');
}

export function isExtracting(state: State, objectId: string): boolean {
  const bound = state.sources.filter((s) => s.boundObjectIds.includes(objectId)).map((s) => s.id);
  return state.extractJobs.some((j) => bound.includes(j.sourceId) && j.status === '抽取中');
}

export function conflictsOf(state: State, claimId: string): Claim[] {
  const self = state.claims.find((c) => c.id === claimId);
  if (!self || self.status === '过时') return [];
  const out: Claim[] = [];
  for (const c of deriveConflicts(state.claims, state.slotDefs)) {
    if (c.claimIdA === claimId) {
      const b = state.claims.find((x) => x.id === c.claimIdB);
      if (b) out.push(b);
    }
    if (c.claimIdB === claimId) {
      const a = state.claims.find((x) => x.id === c.claimIdA);
      if (a) out.push(a);
    }
  }
  return out.filter((c) => c.status !== '过时');
}

export function tabsFor(state: State, objectId: string): RightTab[] {
  return state.rightTabsByObject[objectId] ?? [];
}

export function activeTabIdFor(state: State, objectId: string): string | null {
  return state.activeRightTabByObject[objectId] ?? null;
}

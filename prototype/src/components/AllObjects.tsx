import { Buildings, FolderOpen, Users } from '@phosphor-icons/react';
import { useStore } from '../store';
import type { ObjectKind } from '../types';

// 0032：全部对象——含已归档、含无工作区的孤儿。移除工作区后悬空的对象从这里找回。
export function AllObjectsView() {
  const { state, dispatch } = useStore();
  const icon = (k: ObjectKind) =>
    k === '人' ? <Users size={14} /> : k === '组织' ? <Buildings size={14} /> : <FolderOpen size={14} />;
  const wsName = (workspaceId: string) => {
    const ws = state.workspaces.find((w) => w.id === workspaceId);
    return ws ? ws.name : '无工作区';
  };

  return (
    <section className="all-objects">
      <div className="all-objects-head">
        <h2>全部对象</h2>
        <span className="dim">含已归档、含无工作区；孤儿对象在这里恢复进当前工作区</span>
      </div>
      {state.objects.length === 0 && <div className="dim pad">没有任何对象</div>}
      {state.objects.map((o) => {
        const orphan = !state.workspaces.some((w) => w.id === o.workspaceId);
        const here = o.workspaceId === state.currentWorkspaceId && !o.archived;
        return (
          <div key={o.id} className={`all-object-row${o.archived ? ' archived' : ''}`}>
            <button
              type="button"
              className="session-row-main"
              onClick={() => dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: o.id } })}
            >
              <span className="session-ico">{icon(o.kind)}</span>
              <span className="session-meta">
                <span className="session-name">{o.name}</span>
                <span className="session-sub">
                  {o.kind} · {wsName(o.workspaceId)}
                  {o.archived ? ' · 已归档' : ''}
                  {orphan ? ' · 孤儿' : ''}
                </span>
              </span>
            </button>
            {!here && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => dispatch({ type: 'RESTORE_OBJECT', id: o.id })}
              >
                恢复到当前工作区
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

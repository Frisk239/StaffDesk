import { useState } from 'react';
import { FileText, FolderOpen, IdentificationCard, Plus, X } from '@phosphor-icons/react';
import { activeTabIdFor, tabsFor, useStore } from '../store';
import type { RightTabKind } from '../types';
import { Projection, SourcesPane } from './ObjectPage';
import { BriefView } from './BriefView';

const CATALOG: { kind: RightTabKind; Icon: typeof FileText }[] = [
  { kind: '档案', Icon: IdentificationCard },
  { kind: '来源', Icon: FolderOpen },
  { kind: '简报', Icon: FileText },
];

export function RightPanel({ objectId, width, open }: { objectId: string; width: number; open: boolean }) {
  const { state, dispatch } = useStore();
  const [picker, setPicker] = useState(false);
  const tabs = tabsFor(state, objectId);
  const activeId = activeTabIdFor(state, objectId);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  const openTab = (kind: RightTabKind) => {
    dispatch({ type: 'OPEN_RIGHT_TAB', objectId, kind });
    setPicker(false);
  };

  return (
    <aside className="right-panel" style={{ width: open ? width : 0 }} aria-hidden={!open}>
      <div className="right-inner" style={{ width }}>
      <div className="right-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`right-tab${t.id === active?.id ? ' on' : ''}`}
            onClick={() => dispatch({ type: 'FOCUS_RIGHT_TAB', objectId, id: t.id })}
          >
            {t.kind}
            <span
              className="right-tab-x"
              onClick={(e) => {
                e.stopPropagation();
                dispatch({ type: 'CLOSE_RIGHT_TAB', objectId, id: t.id });
              }}
            >
              <X size={11} />
            </span>
          </button>
        ))}
        <button className="right-tab-add" type="button" onClick={() => setPicker((v) => !v)} aria-label="打开标签页">
          <Plus size={14} />
        </button>
      </div>

      {picker && (
        <div className="tab-picker">
          <div className="tab-picker-title">打开标签页</div>
          <div className="tab-picker-grid">
            {CATALOG.map(({ kind, Icon }) => (
              <button key={kind} type="button" onClick={() => openTab(kind)}>
                <Icon size={22} />
                {kind}
              </button>
            ))}
          </div>
        </div>
      )}

      {!picker && !active && (
        <div className="tab-picker idle">
          <div className="tab-picker-title">打开标签页</div>
          <div className="tab-picker-grid">
            {CATALOG.map(({ kind, Icon }) => (
              <button key={kind} type="button" onClick={() => openTab(kind)}>
                <Icon size={22} />
                {kind}
              </button>
            ))}
          </div>
        </div>
      )}

      {!picker && active?.kind === '档案' && <Projection objectId={objectId} />}
      {!picker && active?.kind === '来源' && <SourcesPane objectId={objectId} />}
      {!picker && active?.kind === '简报' && <BriefPane objectId={objectId} />}
      </div>
    </aside>
  );
}

function BriefPane({ objectId }: { objectId: string }) {
  const { state } = useStore();
  const list = state.briefs.filter((b) => b.objectId === objectId);
  const latest = list[list.length - 1];
  if (!latest) {
    return (
      <div className="empty-guide slim">
        <p className="dim">顶栏「出简报」生成</p>
      </div>
    );
  }
  return <BriefView objectId={objectId} />;
}

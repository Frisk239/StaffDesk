import { useState } from 'react';
import { useStore } from '../store';
import type { CloseReason } from '@shared/types';

export function Takeover({ objectId }: { objectId: string }) {
  const { state, dispatch } = useStore();
  const mine = state.writeQueue.filter((w) => w.objectId === objectId);
  const others = state.writeQueue.filter((w) => w.objectId !== objectId);
  const head = mine[0];
  const restHere = Math.max(0, mine.length - (head ? 1 : 0));
  const [reason, setReason] = useState<CloseReason | ''>('');
  const [newText, setNewText] = useState('');
  const [touched, setTouched] = useState(false);

  if (!head && others.length === 0) return null;

  const jumpOther = () => {
    const first = others[0];
    if (!first) return;
    dispatch({ type: 'SET_VIEW', view: { kind: 'object', objectId: first.objectId } });
  };

  const otherLabel = () => {
    const names = [
      ...new Set(
        others.map((w) => state.objects.find((o) => o.id === w.objectId)?.name ?? w.objectId),
      ),
    ];
    return names.slice(0, 2).join('、');
  };

  const counts = (
    <span className="takeover-more">
      本对象还有 {restHere} 条
      {others.length > 0 && (
        <>
          {' · '}
          <button type="button" className="btn ghost sm" onClick={jumpOther}>
            其他对象还有 {others.length} 条{otherLabel() ? `（${otherLabel()}）` : ''}
          </button>
        </>
      )}
    </span>
  );

  if (!head) {
    return (
      <div className="takeover slim">
        <div className="takeover-strip">
          <span className="takeover-dot" />
          等待确认
          {counts}
        </div>
      </div>
    );
  }

  const confirm = () => {
    if (head.kind === '纠正') {
      // 0037：未核主张纠正=直接丢弃，无需关闭原因。
      const target = head.claimId ? state.claims.find((c) => c.id === head.claimId) : undefined;
      if (target?.unverified) {
        dispatch({ type: 'CONFIRM_WRITE', writeId: head.id, newText: newText || undefined });
        setNewText('');
        setTouched(false);
        return;
      }
      setTouched(true);
      if (reason === '') return;
      dispatch({
        type: 'CONFIRM_WRITE',
        writeId: head.id,
        closeReason: reason,
        newText: newText || undefined,
      });
      setReason('');
      setNewText('');
      setTouched(false);
      return;
    }
    dispatch({ type: 'CONFIRM_WRITE', writeId: head.id });
  };

  const rejectLabel = head.kind === '批量晋升' ? '全部保持' : '拒绝';
  const confirmLabel =
    head.kind === '批量晋升' ? '全部晋升' : head.kind === '批量回退' ? '确认回退' : '确认';

  return (
    // 只拦裸 Enter（提交语义）；Shift+Enter 在 textarea 里保留换行，与 composer 行为一致。
    <div
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
      }}
      className="takeover"
    >
      <div className="takeover-card">
        <div className="takeover-strip">
          <span className="takeover-dot" />
          等待确认
          {counts}
        </div>
        <div className="takeover-body">
          <div className="takeover-headline">{head.headline}</div>
          <pre className="takeover-evidence">{head.evidence}</pre>
          {(head.kind === '批量晋升' || head.kind === '批量回退') && head.claimIds && (
            <div className="takeover-list">
              {head.claimIds.map((id) => {
                const c = state.claims.find((x) => x.id === id);
                return c ? (
                  <div className="takeover-list-row" key={id}>
                    <span className="tag grey">{c.predicate}</span>
                    <span>{c.text}</span>
                  </div>
                ) : null;
              })}
            </div>
          )}
          {head.outbound && head.kind !== '批量晋升' && head.kind !== '批量回退' && (
            <div className="takeover-warn">通过后可出站当定论</div>
          )}
          {head.kind === '批量晋升' && (
            <>
              <div className="takeover-warn">
                全部晋升后可出站当定论；若有冲突，仍会并排展示，不自动裁决。
              </div>
              <div className="takeover-warn">
                选择保持后，本任务中的未核内容会原样保留，不会批量写入。
              </div>
            </>
          )}
          {head.kind === '批量回退' && (
            <div className="takeover-warn">确认后整批回到未核（补偿写，可再晋升）</div>
          )}
          {head.kind === '纠正' &&
            (() => {
              const target = head.claimId
                ? state.claims.find((c) => c.id === head.claimId)
                : undefined;
              if (target?.unverified) {
                return (
                  <>
                    <div className="takeover-warn">
                      这条内容尚未确认；纠正后会直接丢弃，不影响已经确认的结论。
                    </div>
                    <textarea
                      className="takeover-new"
                      rows={2}
                      placeholder="新主张（可选，使用者陈述）"
                      value={newText}
                      onChange={(e) => setNewText(e.target.value)}
                    />
                  </>
                );
              }
              return (
                <>
                  <div className="chip-row">
                    {(['世界已变', '从未成立'] as const).map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={`chip${reason === r ? ' on' : ''}`}
                        onClick={() => setReason(r)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                  <textarea
                    className="takeover-new"
                    rows={2}
                    placeholder="新主张（可选）"
                    value={newText}
                    onChange={(e) => setNewText(e.target.value)}
                  />
                  {touched && reason === '' && <div className="bind-warn">关闭原因必填</div>}
                </>
              );
            })()}
        </div>
        <div className="takeover-actions">
          <button
            type="button"
            className="btn outline danger-hover"
            onClick={() => dispatch({ type: 'REJECT_WRITE', writeId: head.id })}
          >
            {rejectLabel}
          </button>
          <button type="button" className="btn primary" onClick={confirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

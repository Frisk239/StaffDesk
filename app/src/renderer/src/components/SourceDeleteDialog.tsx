import { useEffect } from 'react';
import { useStore } from '../store';

/** 0031/0035：删除来源是重型动作，必须在执行前把关窗和解绑影响数说清。 */
export function SourceDeleteDialog({
  sourceId,
  onClose,
}: {
  sourceId: string;
  onClose: () => void;
}) {
  const { state, dispatch } = useStore();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const source = state.sources.find((item) => item.id === sourceId);
  if (!source || source.virtual) return null;
  const claimCount = state.claims.filter(
    (claim) => claim.sourceId === sourceId && claim.status === '成立',
  ).length;
  const bindingCount = source.boundObjectIds.length;

  return (
    <div className="mini-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="mini-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-source-title"
        aria-describedby="delete-source-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="mini-head" id="delete-source-title">
          删除来源
        </div>
        <p className="dim" id="delete-source-detail">
          删除「{source.title}」将移除 {bindingCount} 个绑定，并把 {claimCount}{' '}
          条相关主张关窗为「来源删除」。历史简报保持不变，此操作不提供一键撤销。
        </p>
        <div className="mini-foot">
          <button type="button" className="ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary danger"
            onClick={() => {
              dispatch({ type: 'DELETE_SOURCE', sourceId });
              onClose();
            }}
          >
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}

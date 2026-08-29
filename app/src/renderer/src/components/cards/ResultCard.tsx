import {
  ArrowUUpLeft,
  ArrowUp,
  CheckCircle,
  Checks,
  FileText,
  FloppyDisk,
  LinkSimple,
  MagnifyingGlass,
  Prohibit,
  Stack,
} from '@phosphor-icons/react';
import { useStore } from '../../store';
import type { ChatCard, ResultKind } from '@shared/types';

// refit-3 P1-1：每种已发生动作用不同 leading 图标；拒绝是禁用圆；撤销（0034）是回拐箭头。
function ResultIcon({ kind }: { kind?: ResultKind | undefined }) {
  const common = { size: 16 as const, weight: 'regular' as const };
  switch (kind) {
    case '关窗':
      return <CheckCircle {...common} />;
    case '晋升':
      return <ArrowUp {...common} />;
    case '批量晋升':
      return <Checks {...common} />;
    case '记忆':
      return <FloppyDisk {...common} />;
    case '简报':
      return <FileText {...common} />;
    case '绑定':
      return <LinkSimple {...common} />;
    case '抽取':
      return <MagnifyingGlass {...common} />;
    case '整理':
      return <Stack {...common} />;
    case '拒绝':
      return <Prohibit {...common} />;
    case '撤销':
      return <ArrowUUpLeft {...common} />;
    default:
      return <CheckCircle {...common} />;
  }
}

export function ResultCard({
  card,
  text,
  objectId,
  messageId,
}: {
  card: ChatCard;
  text: string;
  objectId: string;
  messageId: string;
}) {
  const { state, dispatch } = useStore();
  const ids = card.claimIds ?? (card.claimId ? [card.claimId] : []);
  return (
    <div className="result-row">
      <span className="result-lead">
        <ResultIcon kind={card.result} />
      </span>
      <span className="result-text" title={text}>{text}</span>
      {card.undo && (
        <button
          type="button"
          className="result-undo"
          title="撤销这一步（追加补偿写，不抹历史）"
          aria-label="撤销这一步"
          onClick={() => dispatch({ type: 'UNDO_RESULT', objectId, messageId })}
        >
          <ArrowUUpLeft size={13} />
          撤销
        </button>
      )}
      {ids.map((cid) => {
        const c = state.claims.find((x) => x.id === cid);
        return (
          <button
            key={cid}
            type="button"
            className="ref-chip"
            onClick={() => dispatch({ type: 'OPEN_AUDIT_CARD', claimId: cid })}
          >
            {c ? `〔${c.predicate}〕${c.text.slice(0, 10)}…` : cid}
          </button>
        );
      })}
      {card.briefId && (
        <button
          type="button"
          className="btn ghost sm"
          onClick={() => dispatch({ type: 'OPEN_RIGHT_TAB', objectId, kind: '简报' })}
        >
          打开简报
        </button>
      )}
    </div>
  );
}

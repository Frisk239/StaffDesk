import { useCallback, useRef, useState, type CSSProperties } from 'react';

export function DragHandle({
  side,
  style,
  onStart,
  onDrag,
  onEnd,
}: {
  side: 'session' | 'details';
  style?: CSSProperties;
  onStart: () => void;
  onDrag: (dx: number) => void;
  onEnd: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const origin = useRef(0);
  const latest = useRef(0);
  const frame = useRef<number | null>(null);
  const cb = useRef({ onStart, onDrag, onEnd });
  cb.current = { onStart, onDrag, onEnd };

  const flush = () => {
    frame.current = null;
    cb.current.onDrag(latest.current - origin.current);
  };

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = e.clientX;
    latest.current = e.clientX;
    cb.current.onStart();
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    latest.current = e.clientX;
    frame.current ??= requestAnimationFrame(flush);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    cb.current.onDrag(latest.current - origin.current);
    setDragging(false);
    cb.current.onEnd();
  }, []);

  return (
    <div
      className="col-handle"
      data-side={side}
      data-dragging={dragging || undefined}
      style={style}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}

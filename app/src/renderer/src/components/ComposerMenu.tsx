import { useEffect, useRef, useState, type ReactNode } from 'react';
import { CaretDown } from '@phosphor-icons/react';

export interface MenuOption {
  id: string;
  label: string;
}

export function ComposerMenu({
  label,
  icon,
  value,
  options,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  value: string;
  options: MenuOption[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="cmenu" ref={root}>
      <button
        type="button"
        className={`cmenu-trigger${open ? ' open' : ''}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        <span className="cmenu-value">{current?.label ?? value}</span>
        <CaretDown size={10} weight="bold" />
      </button>
      {open && (
        <div className="cmenu-pop" role="listbox">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === value}
              className={o.id === value ? 'on' : ''}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

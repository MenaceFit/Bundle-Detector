import { useState, type ReactNode } from 'react';

interface SectionProps {
  title: string;
  defaultOpen?: boolean;
  right?: ReactNode;
  children: ReactNode;
}

export function Section({ title, defaultOpen = true, right, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="section">
      <button
        type="button"
        className="section-header"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="section-caret">{open ? '▼' : '▶'}</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{title}</span>
        {right}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

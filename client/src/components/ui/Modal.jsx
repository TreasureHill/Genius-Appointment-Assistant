import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon.jsx';

// Accessible modal dialog: Escape and backdrop click close it, focus moves in
// on open and returns to the opener on close.
export default function Modal({ open, onClose, title, subtitle, children, footer, width = 560, className = '', icon }) {
  const panel = useRef(null);
  // Callers pass inline closures; read the latest one from a ref so a parent
  // re-render never re-runs the open/focus effect (which would steal focus).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const onKey = (e) => {
      if (e.key === 'Escape') closeRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => {
      const el = panel.current?.querySelector('[data-autofocus], input, textarea, select, button:not(.modal-x)');
      el?.focus?.();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearTimeout(t);
      opener?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeRef.current?.()}>
      <div
        ref={panel}
        className={`modal-panel ${className}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        {(title || subtitle) && (
          <div className="modal-head">
            {icon && <span className="modal-icon">{icon}</span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              {title && <div className="modal-title">{title}</div>}
              {subtitle && <div className="modal-sub">{subtitle}</div>}
            </div>
            <button type="button" className="icon-btn modal-x" onClick={onClose} aria-label="Close">
              <Icon name="x" size={18} />
            </button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

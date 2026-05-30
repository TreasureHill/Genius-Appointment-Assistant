import { Component } from 'react';

// App-wide safety net. Without this, any render-time exception unmounts the
// whole React tree and the user sees a blank white page (with no hint why).
// This catches the error, shows a recoverable screen, and surfaces the actual
// message/stack so the failure is diagnosable instead of silent.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the real cause in the console for support / debugging.
    console.error('[app] uncaught render error:', error, info?.componentStack);
  }

  reload = () => {
    window.location.reload();
  };

  clearAndHome = () => {
    try {
      // Page view-state (e.g. the Board's saved project filter) is the most
      // likely thing to wedge a single screen. Clear it without touching the
      // login session, then bounce to the dashboard.
      Object.keys(localStorage)
        .filter((k) => k.startsWith('board:'))
        .forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore storage access errors */
    }
    window.location.assign('/');
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="center" style={{ padding: 24 }}>
        <div className="card" style={{ maxWidth: 560, width: '100%', textAlign: 'left' }}>
          <h1 style={{ marginTop: 0, fontSize: 20 }}>Something went wrong</h1>
          <p className="muted" style={{ marginTop: 0 }}>
            This screen hit an unexpected error. Your data is safe — reloading usually fixes it. If
            it keeps happening on the Board, clearing the saved view resets a stuck filter.
          </p>
          <div
            className="error"
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12.5,
              background: 'var(--danger-soft)',
              border: '1px solid #fecaca',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {String(error?.message || error)}
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={this.reload}>Reload page</button>
            <button className="secondary" onClick={this.clearAndHome}>
              Clear saved view &amp; go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}

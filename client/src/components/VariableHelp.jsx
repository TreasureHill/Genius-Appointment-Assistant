const GROUPS = [
  {
    title: 'Recipient (the buyer this message is being sent to)',
    vars: ['{{buyer.name}}', '{{buyer.firstName}}', '{{buyer.email}}', '{{buyer.phone}}'],
  },
  {
    title: 'Co-buyer (use {{#if coBuyer.present}}…{{/if}} to branch)',
    vars: [
      '{{coBuyer.name}}',
      '{{coBuyer.firstName}}',
      '{{coBuyer.email}}',
      '{{coBuyer.phone}}',
      '{{coBuyer.present}}',
    ],
  },
  {
    title: 'Smart greeting — "Jane and John" if both, else "Jane,"',
    vars: ['{{buyersDisplay}}', '{{buyersFirstDisplay}}'],
  },
  {
    title: 'Third buyer',
    vars: ['{{thirdBuyer.name}}', '{{thirdBuyer.firstName}}', '{{thirdBuyer.email}}'],
  },
  {
    title: 'Lot / Project',
    vars: [
      '{{lot.number}}',
      '{{lot.address}}',
      '{{lot.status}}',
      '{{project.name}}',
    ],
  },
  {
    title: 'Owner / Sender (from Settings → Owner)',
    vars: ['{{owner.name}}', '{{owner.email}}', '{{owner.phone}}', '{{owner.calendlyUrl}}'],
  },
];

export default function VariableHelp() {
  return (
    <details className="var-help" style={{ marginTop: 8 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--muted)' }}>
        Show available variables
      </summary>
      <div style={{ marginTop: 8, display: 'grid', gap: 10 }}>
        {GROUPS.map((g) => (
          <div key={g.title}>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {g.title}
            </div>
            <div style={{ marginTop: 4 }}>
              {g.vars.map((v) => (
                <span
                  key={v}
                  className="kbd"
                  style={{ marginRight: 4, marginBottom: 4, display: 'inline-block' }}
                >
                  {v}
                </span>
              ))}
            </div>
          </div>
        ))}
        <div className="muted" style={{ fontSize: 12 }}>
          Example: <span className="kbd">Hello {`{{buyersFirstDisplay}}`}</span> →
          "Hello Jane and John" or "Hello Jane,".
        </div>
      </div>
    </details>
  );
}

const VARS = [
  '{{buyer.name}}',
  '{{buyer.firstName}}',
  '{{buyer.email}}',
  '{{buyer.phone}}',
  '{{lot.number}}',
  '{{lot.address}}',
  '{{lot.status}}',
  '{{project.name}}',
  '{{rep.name}}',
  '{{rep.email}}',
  '{{rep.calendlyUrl}}',
];

export default function VariableHelp() {
  return (
    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
      Variables:{' '}
      {VARS.map((v) => (
        <span key={v} className="kbd" style={{ marginRight: 4 }}>
          {v}
        </span>
      ))}
    </div>
  );
}

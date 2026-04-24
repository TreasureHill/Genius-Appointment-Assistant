export default function SmsEditor({ value, onChange }) {
  const text = value || '';
  const length = text.length;
  const segments = length === 0 ? 0 : length <= 160 ? 1 : Math.ceil(length / 153);
  return (
    <div>
      <textarea value={text} onChange={(e) => onChange(e.target.value)} rows={5} />
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        {length} chars · {segments} SMS segment{segments === 1 ? '' : 's'}
      </div>
    </div>
  );
}

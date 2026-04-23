export default function StatusBadge({ status }) {
  const cls = `badge ${status || 'pending'}`;
  return <span className={cls}>{(status || 'pending').replace('_', ' ')}</span>;
}

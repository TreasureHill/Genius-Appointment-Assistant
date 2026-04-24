import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Templates() {
  const [list, setList] = useState([]);
  useEffect(() => {
    api.get('/api/templates').then(setList);
  }, []);

  return (
    <div>
      <h1>
        Templates{' '}
        <Link to="/templates/new" style={{ fontSize: 13 }}>
          + new
        </Link>
      </h1>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Subject</th>
              <th>Default reminder</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t._id}>
                <td>
                  <Link to={`/templates/${t._id}`}>{t.name}</Link>
                </td>
                <td>{t.type}</td>
                <td>{t.subject}</td>
                <td>{t.isDefaultReminder ? '★' : ''}</td>
                <td className="muted nowrap">{new Date(t.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr>
                <td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 20 }}>
                  No templates yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

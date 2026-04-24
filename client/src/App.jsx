import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Projects from './pages/Projects.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import LotDetail from './pages/LotDetail.jsx';
import Reps from './pages/Reps.jsx';
import Templates from './pages/Templates.jsx';
import TemplateEditor from './pages/TemplateEditor.jsx';
import SheetImport from './pages/SheetImport.jsx';
import History from './pages/History.jsx';
import Settings from './pages/Settings.jsx';
import CalendlyEvents from './pages/CalendlyEvents.jsx';

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/lots/:id" element={<LotDetail />} />
        <Route path="/reps" element={<Reps />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/templates/new" element={<TemplateEditor />} />
        <Route path="/templates/:id" element={<TemplateEditor />} />
        <Route path="/import" element={<SheetImport />} />
        <Route path="/history" element={<History />} />
        <Route path="/calendly" element={<CalendlyEvents />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

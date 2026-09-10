import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Projects from './pages/Projects.jsx';
import ProjectDetail from './pages/ProjectDetail.jsx';
import ProjectBoard from './pages/ProjectBoard.jsx';
import LotDetail from './pages/LotDetail.jsx';
import Templates from './pages/Templates.jsx';
import TemplateEditor from './pages/TemplateEditor.jsx';
import SheetImport from './pages/SheetImport.jsx';
import Queue from './pages/Queue.jsx';
import Activity from './pages/Activity.jsx';
import Settings from './pages/Settings.jsx';
import CalendlyEvents from './pages/CalendlyEvents.jsx';
import Reports from './pages/Reports.jsx';
import NotFound from './pages/NotFound.jsx';

function Protected({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="center">Loading…</div>;
  // Remember where the user was headed so Login can return them there.
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
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
        <Route path="/board" element={<ProjectBoard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/lots/:id" element={<LotDetail />} />
        <Route path="/templates" element={<Templates />} />
        <Route path="/templates/new" element={<TemplateEditor />} />
        <Route path="/templates/:id" element={<TemplateEditor />} />
        <Route path="/import" element={<SheetImport />} />
        <Route path="/queue" element={<Queue />} />
        <Route path="/activity" element={<Activity />} />
        {/* The old History page is folded into Activity (same data, more filters). */}
        <Route path="/history" element={<Navigate to="/activity" replace />} />
        <Route path="/calendly" element={<CalendlyEvents />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        {/* Unknown paths get a real 404 inside the app shell instead of a
            silent redirect to the dashboard. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router-dom";
import { Nav } from "./Nav";
import { api } from "../api";

export function AppLayout() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api
      .get("/api/auth/me")
      .then(() => setReady(true))
      .catch(() => navigate("/login", { replace: true }));
  }, [navigate]);

  if (!ready) {
    return <div className="p-6 text-slate-500">Loading…</div>;
  }

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
    </>
  );
}

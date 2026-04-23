import { Link, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { api } from "../api";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
  { href: "/templates", label: "Templates" },
  { href: "/reps", label: "Reps" },
  { href: "/history", label: "History" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const location = useLocation();
  const navigate = useNavigate();

  async function signOut() {
    await api.post("/api/auth/logout");
    navigate("/login", { replace: true });
  }

  return (
    <nav className="sticky top-0 z-10 border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-6">
          <span className="font-semibold">Genius</span>
          <div className="flex items-center gap-2">
            {links.map((l) => (
              <Link
                key={l.href}
                to={l.href}
                className={clsx(
                  "rounded-md px-2.5 py-1.5 text-sm",
                  location.pathname.startsWith(l.href)
                    ? "bg-brand-50 text-brand-700"
                    : "text-slate-600 hover:bg-slate-100"
                )}
              >
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <button className="text-sm text-slate-500 hover:text-slate-700" onClick={signOut}>
          Sign out
        </button>
      </div>
    </nav>
  );
}

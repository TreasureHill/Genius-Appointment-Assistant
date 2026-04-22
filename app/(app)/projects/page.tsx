import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { CreateProjectForm } from "./create-form";

export default async function ProjectsPage() {
  const projects = await prisma.project.findMany({
    include: { lots: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projects</h1>
      </div>

      <CreateProjectForm />

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th className="text-right">Lots</th>
              <th className="text-right">Reminder interval</th>
              <th className="text-right">Max reminders</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {projects.length === 0 && (
              <tr><td colSpan={5} className="text-center text-slate-500 py-6">No projects yet.</td></tr>
            )}
            {projects.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link className="text-brand-600 hover:underline" href={`/projects/${p.id}`}>
                    {p.name}
                  </Link>
                </td>
                <td className="text-right">{p.lots.length}</td>
                <td className="text-right">{p.reminderIntervalDays}d</td>
                <td className="text-right">{p.maxReminders}</td>
                <td className="text-right">
                  <Link className="text-sm text-brand-600 hover:underline" href={`/projects/${p.id}`}>
                    Open →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

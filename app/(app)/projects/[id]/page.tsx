import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { StatusBadge } from "@/components/status-badge";
import { ProjectTools } from "./project-tools";
import { ProjectSettings } from "./project-settings";

type Props = { params: { id: string }; searchParams: { rep?: string; status?: string } };

export default async function ProjectDetailPage({ params, searchParams }: Props) {
  const project = await prisma.project.findUnique({ where: { id: params.id } });
  if (!project) notFound();

  const [reps, templates] = await Promise.all([
    prisma.rep.findMany({ orderBy: { name: "asc" } }),
    prisma.template.findMany({ orderBy: { updatedAt: "desc" } }),
  ]);

  const lots = await prisma.lot.findMany({
    where: {
      projectId: project.id,
      assignedRepId: searchParams.rep ? searchParams.rep : undefined,
      status: searchParams.status ? searchParams.status : undefined,
    },
    include: { buyers: true, assignedRep: true },
    orderBy: { lotNumber: "asc" },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500">
            <Link href="/projects" className="hover:underline">Projects</Link> / {project.name}
          </div>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <div className="text-sm text-slate-500">
            Reminder every {project.reminderIntervalDays}d · max {project.maxReminders} reminders
          </div>
        </div>
      </div>

      <ProjectTools projectId={project.id} />

      <ProjectSettings
        project={{
          id: project.id,
          reminderIntervalDays: project.reminderIntervalDays,
          maxReminders: project.maxReminders,
          defaultEmailTemplateId: project.defaultEmailTemplateId,
          defaultSmsTemplateId: project.defaultSmsTemplateId,
        }}
        templates={templates.map((t) => ({ id: t.id, name: t.name, type: t.type }))}
      />

      <div className="card">
        <form className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="label">Filter by rep</label>
            <select name="rep" defaultValue={searchParams.rep ?? ""} className="input">
              <option value="">All reps</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select name="status" defaultValue={searchParams.status ?? ""} className="input">
              <option value="">All</option>
              {["NEW", "CONTACTED", "SCHEDULED", "BOOKED", "OPTED_OUT"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <button className="btn-ghost" type="submit">Apply</button>
        </form>

        <table className="table">
          <thead>
            <tr>
              <th>Lot #</th>
              <th>Address</th>
              <th>Status</th>
              <th>Rep</th>
              <th>Buyers</th>
              <th className="text-right">Reminders</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lots.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-500 py-6">No lots. Import a sheet to add some.</td></tr>
            )}
            {lots.map((lot) => (
              <tr key={lot.id}>
                <td className="font-medium">{lot.lotNumber}</td>
                <td className="text-slate-500">{lot.address ?? "—"}</td>
                <td><StatusBadge status={lot.status} /></td>
                <td>{lot.assignedRep?.name ?? <span className="text-slate-400">Unassigned</span>}</td>
                <td className="text-slate-500">
                  {lot.buyers.map((b) => b.name).join(", ") || "—"}
                </td>
                <td className="text-right">{lot.reminderCount}</td>
                <td className="text-right">
                  <Link href={`/projects/${project.id}/lots/${lot.id}`}
                        className="text-sm text-brand-600 hover:underline">Edit →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

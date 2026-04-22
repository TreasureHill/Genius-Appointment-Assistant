import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { NewTemplateForm } from "./new-template-form";

export default async function TemplatesPage() {
  const list = await prisma.template.findMany({ orderBy: { updatedAt: "desc" } });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Templates</h1>

      <NewTemplateForm />

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr><td colSpan={4} className="text-center text-slate-500 py-6">No templates yet.</td></tr>
            )}
            {list.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td><span className="badge bg-slate-100 text-slate-700">{t.type}</span></td>
                <td className="text-slate-500">{t.updatedAt.toLocaleString()}</td>
                <td className="text-right">
                  <Link className="text-sm text-brand-600 hover:underline" href={`/templates/${t.id}`}>Edit →</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

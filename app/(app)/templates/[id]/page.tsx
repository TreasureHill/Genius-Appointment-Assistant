import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { TemplateEditor } from "./template-editor";

type Props = { params: { id: string } };

export default async function TemplateEditPage({ params }: Props) {
  const t = await prisma.template.findUnique({ where: { id: params.id } });
  if (!t) notFound();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">{t.name}</h1>
        <div className="text-sm text-slate-500">{t.type} template</div>
      </div>
      <TemplateEditor
        initial={{
          id: t.id,
          type: t.type as "EMAIL" | "SMS",
          name: t.name,
          subject: t.subject ?? "",
          bodyHtml: t.bodyHtml ?? "",
          bodyText: t.bodyText ?? "",
        }}
      />
    </div>
  );
}

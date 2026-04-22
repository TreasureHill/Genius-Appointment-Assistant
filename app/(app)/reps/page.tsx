import { prisma } from "@/lib/prisma";
import { RepsManager } from "./reps-manager";

export default async function RepsPage() {
  const reps = await prisma.rep.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { lots: true } } },
  });
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Reps</h1>
      <p className="text-sm text-slate-500">
        Reps are labels you can attach to lots so you can filter the lot list by rep. They do not get their
        own login.
      </p>
      <RepsManager
        initial={reps.map((r) => ({
          id: r.id,
          name: r.name,
          email: r.email,
          phone: r.phone,
          active: r.active,
          lotCount: r._count.lots,
        }))}
      />
    </div>
  );
}

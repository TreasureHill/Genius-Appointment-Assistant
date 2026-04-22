import clsx from "clsx";

const styles: Record<string, string> = {
  NEW: "bg-slate-100 text-slate-700",
  CONTACTED: "bg-blue-100 text-blue-800",
  SCHEDULED: "bg-amber-100 text-amber-800",
  BOOKED: "bg-emerald-100 text-emerald-800",
  OPTED_OUT: "bg-red-100 text-red-800",
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={clsx("badge", styles[status] ?? "bg-slate-100 text-slate-700")}>{status}</span>;
}

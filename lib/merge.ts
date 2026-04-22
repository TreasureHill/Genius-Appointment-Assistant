export type MergeContext = {
  buyer: {
    name: string;
    firstName: string;
    email: string;
    phone: string;
    role: string;
  };
  lot: {
    lotNumber: string;
    address: string;
    status: string;
  };
  project: {
    name: string;
  };
  rep: {
    name: string;
    email: string;
    phone: string;
  };
};

export const MERGE_TAGS = [
  "{{buyer.name}}",
  "{{buyer.firstName}}",
  "{{buyer.email}}",
  "{{buyer.phone}}",
  "{{buyer.role}}",
  "{{lot.lotNumber}}",
  "{{lot.address}}",
  "{{lot.status}}",
  "{{project.name}}",
  "{{rep.name}}",
  "{{rep.email}}",
  "{{rep.phone}}",
] as const;

const TAG_RE = /\{\{\s*([a-zA-Z]+)\.([a-zA-Z]+)\s*\}\}/g;

export function renderTemplate(body: string, ctx: MergeContext): string {
  return body.replace(TAG_RE, (_match, objKey: string, field: string) => {
    const obj = (ctx as unknown as Record<string, Record<string, string>>)[objKey];
    if (!obj) return "";
    const v = obj[field];
    return v ?? "";
  });
}

export function buildContext(args: {
  buyer: { name: string; email?: string | null; phone?: string | null; role: string };
  lot: { lotNumber: string; address?: string | null; status: string };
  project: { name: string };
  rep?: { name: string; email?: string | null; phone?: string | null } | null;
}): MergeContext {
  const [firstName] = args.buyer.name.split(" ");
  return {
    buyer: {
      name: args.buyer.name,
      firstName: firstName ?? args.buyer.name,
      email: args.buyer.email ?? "",
      phone: args.buyer.phone ?? "",
      role: args.buyer.role,
    },
    lot: {
      lotNumber: args.lot.lotNumber,
      address: args.lot.address ?? "",
      status: args.lot.status,
    },
    project: { name: args.project.name },
    rep: {
      name: args.rep?.name ?? "",
      email: args.rep?.email ?? "",
      phone: args.rep?.phone ?? "",
    },
  };
}

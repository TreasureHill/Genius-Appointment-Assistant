import { prisma } from "./prisma";
import { getSetting, type CalendlySettings } from "./settings";

type CalendlyEventApi = {
  uri: string;
  start_time: string;
  status: string; // "active" | "canceled"
};

type CalendlyInviteeApi = {
  email: string;
  event: string; // event uri
};

async function calendlyFetch<T>(path: string, token: string): Promise<T> {
  const url = path.startsWith("http") ? path : `https://api.calendly.com${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendly ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export async function listRecentEvents(days = 30) {
  const cfg = await getSetting<CalendlySettings>("calendly");
  if (!cfg?.token || !cfg.orgUri) return null;
  const minTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const qs = new URLSearchParams({
    organization: cfg.orgUri,
    min_start_time: minTime,
    count: "100",
  });
  type Resp = { collection: CalendlyEventApi[]; pagination?: { next_page?: string } };
  let page = await calendlyFetch<Resp>(`/scheduled_events?${qs}`, cfg.token);
  const events: CalendlyEventApi[] = [...page.collection];
  while (page.pagination?.next_page) {
    page = await calendlyFetch<Resp>(page.pagination.next_page, cfg.token);
    events.push(...page.collection);
  }

  for (const ev of events) {
    const invitees = await calendlyFetch<{ collection: CalendlyInviteeApi[] }>(
      `${ev.uri}/invitees`,
      cfg.token
    );
    for (const inv of invitees.collection) {
      await upsertEvent({
        eventUri: ev.uri,
        inviteeEmail: inv.email,
        startTime: new Date(ev.start_time),
        status: ev.status.toUpperCase() === "CANCELED" ? "CANCELED" : "ACTIVE",
      });
    }
  }
  return { count: events.length };
}

export async function upsertEvent(args: {
  eventUri: string;
  inviteeEmail: string;
  startTime: Date;
  status: "ACTIVE" | "CANCELED";
}) {
  const email = args.inviteeEmail.toLowerCase();
  const buyer = await prisma.buyer.findFirst({
    where: { email: { equals: email } },
    include: { lot: true },
  });

  const saved = await prisma.calendlyEvent.upsert({
    where: { eventUri: args.eventUri },
    update: {
      inviteeEmail: email,
      startTime: args.startTime,
      status: args.status,
      matchedBuyerId: buyer?.id,
      matchedLotId: buyer?.lotId,
    },
    create: {
      eventUri: args.eventUri,
      inviteeEmail: email,
      startTime: args.startTime,
      status: args.status,
      matchedBuyerId: buyer?.id,
      matchedLotId: buyer?.lotId,
    },
  });

  if (buyer && args.status === "ACTIVE") {
    await prisma.lot.update({
      where: { id: buyer.lotId },
      data: {
        status: buyer.lot.status === "BOOKED" ? buyer.lot.status : "SCHEDULED",
        scheduledAt: args.startTime,
      },
    });
  }
  return saved;
}

/** Emails with more than one ACTIVE event — powers the warning badge. */
export async function multiEventEmails(): Promise<Array<{ email: string; count: number }>> {
  const grouped = await prisma.calendlyEvent.groupBy({
    by: ["inviteeEmail"],
    where: { status: "ACTIVE" },
    _count: { _all: true },
    having: { inviteeEmail: { _count: { gt: 1 } } },
  });
  return grouped.map((g) => ({ email: g.inviteeEmail, count: g._count._all }));
}

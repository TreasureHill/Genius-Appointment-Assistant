import { prisma } from "./prisma";

export type PacingSettings = {
  minSec: number;
  maxSec: number;
  dailyCapPerDomain: number;
};

export async function getSetting<T>(key: string): Promise<T | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value: JSON.stringify(value) },
    create: { key, value: JSON.stringify(value) },
  });
}

export async function getPacing(): Promise<PacingSettings> {
  return (
    (await getSetting<PacingSettings>("pacing")) ?? {
      minSec: 45,
      maxSec: 180,
      dailyCapPerDomain: 200,
    }
  );
}

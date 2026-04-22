import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL ?? "admin@example.com";
  const password = process.env.ADMIN_PASSWORD ?? "change-me";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.create({ data: { email, passwordHash } });
    console.log(`Seeded admin user: ${email}`);
  } else {
    console.log(`Admin user already exists: ${email}`);
  }

  const defaultPacing = { minSec: 45, maxSec: 180, dailyCapPerDomain: 200 };
  await prisma.setting.upsert({
    where: { key: "pacing" },
    update: {},
    create: { key: "pacing", value: JSON.stringify(defaultPacing) },
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

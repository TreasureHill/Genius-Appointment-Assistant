// One-off demo seeder: `npm run seed`
require('../config/env');
const { connect } = require('../config/db');
const Project = require('../models/Project');
const Lot = require('../models/Lot');
const { seedAdmin, seedStarterTemplates } = require('./seedBoot');

async function main() {
  await connect();
  await seedAdmin();
  await seedStarterTemplates();

  const project = await Project.findOneAndUpdate(
    { name: 'Riverside Phase 1' },
    {
      $setOnInsert: {
        name: 'Riverside Phase 1',
        description: 'Demo project',
        reminderIntervalDays: 14,
        maxReminders: 3,
        pacing: { minSec: 30, maxSec: 120 },
      },
    },
    { upsert: true, new: true }
  );

  await Lot.updateOne(
    { project: project._id, lotNumber: '101' },
    {
      $setOnInsert: {
        project: project._id,
        lotNumber: '101',
        address: '101 River Rd',
        buyers: [
          { role: 'buyer', name: 'Jane Owner', email: 'jane@example.com', phone: '+15555550101' },
          { role: 'coBuyer', name: 'John Owner', email: 'john@example.com', phone: '+15555550102' },
        ],
      },
    },
    { upsert: true }
  );

  console.log('Seed complete.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

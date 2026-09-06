// Minimal clinic inserter - uses the built prisma client
// Run with: docker exec healthcare-api node /app/scripts/insert-clinic.js
'use strict';

// Resolve prisma client from the known location
const clientPath = '/app/src/generated/client/index.js';
const { PrismaClient } = require(clientPath);

async function main() {
  const prisma = new PrismaClient({ log: ['error'] });

  try {
    // Check existing
    const existing = await prisma.clinic.findFirst({
      where: { clinicId: 'CL0002' },
      select: { id: true, clinicId: true, name: true },
    });

    console.log('Existing CL0002:', existing);

    if (!existing) {
      const clinic = await prisma.clinic.create({
        data: {
          clinicId: 'CL0002',
          name: 'Dr. Deshmukh Clinic',
          phone: '+91-9876543210',
          email: 'clinic@example.com',
          app_name: 'DrDeshmukhClinic',
          address: 'Pune, Maharashtra',
          isActive: true,
          createdBy: 'SYSTEM',
          databaseStatus: 'ACTIVE',
          db_connection_string: 'postgresql://postgres:postgres@postgres:5432/userdb',
        },
      });
      console.log('Created:', JSON.stringify(clinic));
    } else {
      console.log('Clinic CL0002 already exists, nothing to do.');
    }
  } catch (err) {
    console.error('Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

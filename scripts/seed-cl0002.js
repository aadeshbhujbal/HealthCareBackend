// Simple script to seed CL0002 clinic into the local Docker Postgres
const { PrismaClient } = require('./src/libs/infrastructure/database/prisma/generated/client/index.js');

async function main() {
  const prisma = new PrismaClient();
  try {
    // Check if clinic already exists
    const existing = await prisma.clinic.findFirst({
      where: { clinicId: 'CL0002' },
    });
    if (existing) {
      console.log('CL0002 already exists:', existing.clinicId, existing.name);
      return;
    }

    // Create the clinic
    const clinic = await prisma.clinic.create({
      data: {
        clinicId: 'CL0002',
        name: 'Dr. Chandrakumar Deshmukh Clinic',
        address: 'Pune, Maharashtra',
        phone: '+919876543210',
        email: 'clinic@deshmukhclinic.in',
        app_name: 'DrDeshmukhClinic',
        db_connection_string: 'postgresql://postgres:postgres@postgres:5432/userdb',
        databaseStatus: 'ACTIVE',
        isActive: true,
      },
      select: { clinicId: true, name: true, isActive: true },
    });
    console.log('Created clinic:', clinic);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();

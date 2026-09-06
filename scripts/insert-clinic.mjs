const { Client } = require('pg');

const client = new Client({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'userdb',
});

async function main() {
  await client.connect();
  console.log('Connected to DB');

  // Check if Clinic table exists
  const tableCheck = await client.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'Clinic'
    );
  `);
  console.log('Clinic table exists:', tableCheck.rows[0].exists);

  if (tableCheck.rows[0].exists) {
    // Check existing clinics
    const clinics = await client.query('SELECT "clinicId", name, "isActive" FROM "Clinic" LIMIT 5');
    console.log('Existing clinics:', clinics.rows);

    // Insert CL0002 if not exists
    const result = await client.query(`
      INSERT INTO "Clinic" ("clinicId", name, "phone", "email", "app_name", address, "isActive", "createdBy", "db_connection_string", "databaseStatus")
      VALUES ('CL0002', 'Dr. Deshmukh Clinic', '+91-9876543210', 'clinic@example.com', 'DrDeshmukhClinic', 'Pune, Maharashtra', true, 'SYSTEM', 'localhost:5432', 'ACTIVE')
      ON CONFLICT ("clinicId") DO NOTHING
      RETURNING id, "clinicId", name;
    `);
    console.log('Inserted clinic:', result.rows);
  }

  await client.end();
  console.log('Done');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

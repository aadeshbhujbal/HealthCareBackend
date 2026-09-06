import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/userdb?sslmode=disable',
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Set UUID defaults for id columns
    await client.query(`ALTER TABLE clinics ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
    await client.query(`ALTER TABLE users ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
    await client.query(`ALTER TABLE "Doctor" ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
    await client.query(`ALTER TABLE "RbacRole" ALTER COLUMN id SET DEFAULT gen_random_uuid()`);
    await client.query(`ALTER TABLE "UserRole" ALTER COLUMN id SET DEFAULT gen_random_uuid()`);

    // 1. Create system user
    const sysResult = await client.query(`
      INSERT INTO users ("userId", name, role, "isVerified", "isActive", "isProfileComplete", "phoneVerified", "createdAt", "updatedAt", email, "appName")
      SELECT 'SYS001', 'System', 'SUPER_ADMIN', true, true, true, true, NOW(), NOW(), 'system@localhost', 'Healthcare App'
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'system@localhost')
      RETURNING id
    `);
    const systemId = sysResult.rows[0]?.id;
    console.log('System user:', systemId || 'already exists');

    // 2. Create clinic
    const clinicResult = await client.query(`
      INSERT INTO clinics ("clinicId", name, address, phone, email, "app_name", "databaseStatus", "isActive", "createdAt", "updatedAt", "createdBy", "timezone", "currency", "language")
      SELECT 'CL0002', 'Aadesh Ayurvedalay', '123 Ayurveda Road, Pune', '+919876543210', 'clinic@cl0002.in', 'Healthcare App', 'CREATING', true, NOW(), NOW(), $1, 'UTC', 'INR', 'en'
      WHERE NOT EXISTS (SELECT 1 FROM clinics WHERE "clinicId" = 'CL0002')
      RETURNING id
    `, [systemId]);
    const clinicId = clinicResult.rows[0]?.id;
    console.log('Clinic:', clinicId || 'already exists');

    // Get existing clinic ID if not newly created
    let finalClinicId = clinicId;
    if (!finalClinicId) {
      const existingClinic = await client.query(`SELECT id FROM clinics WHERE "clinicId" = 'CL0002'`);
      finalClinicId = existingClinic.rows[0]?.id;
    }

    // 3. Create doctor user
    const docUserResult = await client.query(`
      INSERT INTO users ("userId", email, name, role, "primaryClinicId", "isVerified", "isActive", "isProfileComplete", "phoneVerified", "createdAt", "updatedAt")
      SELECT 'DOC001', 'doctor@cl0002.in', 'Dr. Test Doctor', 'DOCTOR', $1, true, true, true, true, NOW(), NOW()
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = 'doctor@cl0002.in')
      RETURNING id
    `, [finalClinicId]);
    const doctorUserId = docUserResult.rows[0]?.id;
    console.log('Doctor user:', doctorUserId || 'already exists');

    // Get existing user ID
    let finalDocUserId = doctorUserId;
    if (!finalDocUserId) {
      const existingUser = await client.query(`SELECT id FROM users WHERE email = 'doctor@cl0002.in'`);
      finalDocUserId = existingUser.rows[0]?.id;
    }

    if (finalDocUserId) {
      // 4. Create doctor record
      const docResult = await client.query(`
        INSERT INTO "Doctor" ("userId", specialization, experience, consultationFee, isAvailable, rating, createdAt)
        SELECT $1, 'Ayurveda', 10, 500, true, 4.5, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM "Doctor" WHERE "userId" = $1)
        RETURNING id
      `, [finalDocUserId]);
      console.log('Doctor record:', docResult.rows[0]?.id || 'already exists');

      // 5. Create RbacRole
      const roleResult = await client.query(`
        INSERT INTO "RbacRole" (name, "displayName", description, "isSystemRole", "isActive", "clinicId", "createdAt", "updatedAt")
        SELECT 'DOCTOR', 'Doctor', 'Doctor role', true, true, $1, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM "RbacRole" WHERE name = 'DOCTOR')
        RETURNING id
      `, [finalClinicId]);
      const roleId = roleResult.rows[0]?.id;
      console.log('Role:', roleId || 'already exists');

      // Get existing role ID
      let finalRoleId = roleId;
      if (!finalRoleId) {
        const existingRole = await client.query(`SELECT id FROM "RbacRole" WHERE name = 'DOCTOR'`);
        finalRoleId = existingRole.rows[0]?.id;
      }

      // 6. Create UserRole
      await client.query(`
        INSERT INTO "UserRole" ("userId", "roleId", "clinicId", "isPrimary", "isActive", "createdAt", "updatedAt")
        SELECT $1, $2, $3, true, true, NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM "UserRole" WHERE "userId" = $1 AND "roleId" = $2 AND "clinicId" = $3)
      `, [finalDocUserId, finalRoleId, finalClinicId]);
      console.log('UserRole assigned');
    }

    await client.query('COMMIT');
    console.log('\n=== Seed completed! Login with: doctor@cl0002.in ===');
  } catch (e: any) {
    await client.query('ROLLBACK');
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();

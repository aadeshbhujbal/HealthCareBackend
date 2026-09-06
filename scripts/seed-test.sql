-- Seed test data for CL0002 clinic
-- Use exact column names from information_schema

INSERT INTO clinics ("clinicId", name, address, phone, email, "isActive", "createdAt", "updatedAt")
SELECT 'CL0002', 'Aadesh Ayurvedalay', '123 Ayurveda Road, Pune', '+919876543210', 'clinic@cl0002.in', true, NOW(), NOW()
WHERE NOT EXISTS (SELECT 1 FROM clinics WHERE "clinicId" = 'CL0002')
RETURNING id;

INSERT INTO users ("userid", email, name, role, "primaryClinicId", "isVerified", phone, "phoneVerified", "isActive", "profileCompletedAt", "isProfileComplete", "createdAt", "updatedAt")
SELECT 'DOC001', 'doctor@cl0002.in', 'Dr. Test Doctor', 'DOCTOR', c.id, true, '+919876543210', true, true, NOW(), true, NOW(), NOW()
FROM clinics c
WHERE c."clinicId" = 'CL0002'
  AND NOT EXISTS (SELECT 1 FROM users WHERE email = 'doctor@cl0002.in')
RETURNING id;

SELECT 'clinics' as tbl, COUNT(*) as cnt FROM clinics
UNION ALL
SELECT 'users', COUNT(*) FROM users;

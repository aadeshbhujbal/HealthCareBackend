-- Insert CL0002 clinic for local development testing
INSERT INTO "Clinic" ("clinicId", name, "phone", "email", "app_name", address, "isActive", "createdBy", "databaseStatus", "db_connection_string")
VALUES ('CL0002', 'Dr. Deshmukh Clinic', '+91-9876543210', 'clinic@example.com', 'DrDeshmukhClinic', 'Pune, Maharashtra', true, 'SYSTEM', 'ACTIVE', 'postgresql://postgres:postgres@postgres:5432/userdb')
ON CONFLICT ("clinicId") DO NOTHING;

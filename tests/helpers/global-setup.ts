import { execFileSync } from 'node:child_process';

/** Applies committed migrations to the isolated test database before infra-backed suites. */
export default function setup(): void {
  const databaseUrl =
    process.env['TEST_DATABASE_URL'] ?? 'postgresql://chat:chat@localhost:5432/chat_test';
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

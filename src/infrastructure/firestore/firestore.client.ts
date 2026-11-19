import { randomUUID } from 'node:crypto';
import {
  applicationDefault,
  cert,
  deleteApp,
  initializeApp,
  type AppOptions,
} from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

const serviceAccountSchema = z.object({
  project_id: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

export interface FirestoreConfig {
  projectId: string;
  emulatorHost?: string | undefined;
  serviceAccountBase64?: string | undefined;
}

export interface FirestoreConnection {
  db: Firestore;
  close(): Promise<void>;
}

/**
 * Credential precedence: emulator (no credentials) > explicit service account > ADC.
 * The service account is decoded in memory only and never logged.
 */
export function createFirestore(config: FirestoreConfig): FirestoreConnection {
  const options: AppOptions = { projectId: config.projectId };
  if (!config.emulatorHost) {
    options.credential = config.serviceAccountBase64
      ? cert(decodeServiceAccount(config.serviceAccountBase64))
      : applicationDefault();
  }
  // A unique app name lets tests run several isolated instances in one process.
  const app = initializeApp(options, `chat-backend-${randomUUID()}`);
  const db = getFirestore(app);
  return {
    db,
    close: async () => {
      await db.terminate();
      await deleteApp(app);
    },
  };
}

function decodeServiceAccount(base64: string): {
  projectId: string;
  clientEmail: string;
  privateKey: string;
} {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not valid base64-encoded JSON');
  }
  const parsed = serviceAccountSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is missing required service-account fields');
  }
  return {
    projectId: parsed.data.project_id,
    clientEmail: parsed.data.client_email,
    privateKey: parsed.data.private_key,
  };
}

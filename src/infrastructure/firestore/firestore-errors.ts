import { AppError, ExternalServiceError } from '../../shared/errors/app-error.js';

/** gRPC status codes surfaced by the Firestore client. */
export const GrpcStatus = {
  DEADLINE_EXCEEDED: 4,
  ALREADY_EXISTS: 6,
  RESOURCE_EXHAUSTED: 8,
  ABORTED: 10,
  UNAVAILABLE: 14,
} as const;

const TRANSIENT = new Set<number>([
  GrpcStatus.DEADLINE_EXCEEDED,
  GrpcStatus.RESOURCE_EXHAUSTED,
  GrpcStatus.ABORTED,
  GrpcStatus.UNAVAILABLE,
]);

export function grpcCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'number' ? error.code : undefined;
  }
  return undefined;
}

/** Maps transient Firestore failures to a 503 so clients know a retry is reasonable. */
export async function withFirestore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = grpcCode(error);
    if (code !== undefined && TRANSIENT.has(code)) {
      throw new ExternalServiceError('Firestore', { cause: error });
    }
    throw error;
  }
}

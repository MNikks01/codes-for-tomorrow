import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import type { ReadReceipt, ReceiptStore } from '../../modules/messages/message.types.js';
import { GrpcStatus, grpcCode, withFirestore } from './firestore-errors.js';

const receiptDocSchema = z.object({ readAt: z.instanceof(Timestamp) });

/**
 * chats/{chatId}/messages/{messageId}/readReceipts/{userId}
 * One small document per reader keeps message documents bounded in size.
 */
export class FirestoreReceiptStore implements ReceiptStore {
  constructor(private readonly db: Firestore) {}

  async markRead(
    chatId: string,
    messageId: string,
    userId: string,
  ): Promise<{ receipt: ReadReceipt; created: boolean }> {
    return withFirestore(async () => {
      const ref = this.db
        .collection('chats')
        .doc(chatId)
        .collection('messages')
        .doc(messageId)
        .collection('readReceipts')
        .doc(userId);

      // create() is atomic: concurrent duplicates fail with ALREADY_EXISTS and keep the first readAt.
      let created = true;
      try {
        await ref.create({ chatId, messageId, userId, readAt: FieldValue.serverTimestamp() });
      } catch (error) {
        if (grpcCode(error) !== GrpcStatus.ALREADY_EXISTS) throw error;
        created = false;
      }

      const snapshot = await ref.get();
      const doc = receiptDocSchema.parse(snapshot.data());
      return { receipt: { chatId, messageId, userId, readAt: doc.readAt.toDate() }, created };
    });
  }
}

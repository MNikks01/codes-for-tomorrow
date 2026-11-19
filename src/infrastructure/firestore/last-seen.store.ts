import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  comparePositions,
  type LastSeen,
  type LastSeenStore,
  type Message,
} from '../../modules/messages/message.types.js';
import { withFirestore } from './firestore-errors.js';

const lastSeenDocSchema = z.object({
  messageId: z.string(),
  messageCreatedAt: z.instanceof(Timestamp),
  lastSeenAt: z.instanceof(Timestamp),
});

/** chats/{chatId}/lastSeen/{userId} */
export class FirestoreLastSeenStore implements LastSeenStore {
  constructor(private readonly db: Firestore) {}

  async advance(
    chatId: string,
    userId: string,
    message: Message,
  ): Promise<{ lastSeen: LastSeen; updated: boolean }> {
    return withFirestore(async () => {
      const ref = this.db.collection('chats').doc(chatId).collection('lastSeen').doc(userId);

      // Read-compare-write inside a transaction: Firestore retries on contention,
      // so concurrent updates can only ever move the pointer forward.
      const updated = await this.db.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        if (snapshot.exists) {
          const current = lastSeenDocSchema.parse(snapshot.data());
          const currentPosition = {
            seconds: current.messageCreatedAt.seconds,
            nanos: current.messageCreatedAt.nanoseconds,
            id: current.messageId,
          };
          if (comparePositions(currentPosition, message.position) >= 0) return false;
        }
        tx.set(ref, {
          chatId,
          userId,
          messageId: message.id,
          messageCreatedAt: new Timestamp(message.position.seconds, message.position.nanos),
          lastSeenAt: FieldValue.serverTimestamp(),
        });
        return true;
      });

      const doc = lastSeenDocSchema.parse((await ref.get()).data());
      return {
        lastSeen: {
          chatId,
          userId,
          messageId: doc.messageId,
          messageCreatedAt: doc.messageCreatedAt.toDate(),
          lastSeenAt: doc.lastSeenAt.toDate(),
        },
        updated,
      };
    });
  }
}

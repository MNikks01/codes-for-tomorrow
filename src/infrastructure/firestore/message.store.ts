import { createHash } from 'node:crypto';
import {
  FieldPath,
  FieldValue,
  Timestamp,
  type CollectionReference,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import { z } from 'zod';
import { ConflictError } from '../../shared/errors/app-error.js';
import type {
  CreateMessageInput,
  Message,
  MessageMutation,
  MessagePage,
  MessagePosition,
  MessageStore,
} from '../../modules/messages/message.types.js';
import { GrpcStatus, grpcCode, withFirestore } from './firestore-errors.js';

const timestamp = z.instanceof(Timestamp);

const messageDocSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  senderId: z.string(),
  text: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  editedAt: timestamp.nullable(),
  deletedAt: timestamp.nullable().default(null),
});

/** chats/{chatId}/messages/{messageId} */
export class FirestoreMessageStore implements MessageStore {
  constructor(private readonly db: Firestore) {}

  async create(input: CreateMessageInput): Promise<{ message: Message; created: boolean }> {
    return withFirestore(async () => {
      const collection = this.collection(input.chatId);
      // A deterministic ID turns client retries into no-ops: create() fails if it exists.
      const keyHash = input.idempotencyKey
        ? hashIdempotencyKey(input.senderId, input.idempotencyKey)
        : null;
      const ref = keyHash ? collection.doc(keyHash) : collection.doc();
      const now = FieldValue.serverTimestamp();

      try {
        await ref.create({
          id: ref.id,
          chatId: input.chatId,
          senderId: input.senderId,
          text: input.text,
          createdAt: now,
          updatedAt: now,
          editedAt: null,
          deletedAt: null,
          idempotencyKeyHash: keyHash,
        });
      } catch (error) {
        if (keyHash === null || grpcCode(error) !== GrpcStatus.ALREADY_EXISTS) throw error;
        const existing = await this.read(ref);
        if (existing?.senderId !== input.senderId || existing.text !== input.text) {
          throw new ConflictError('Idempotency-Key was already used for a different message');
        }
        return { message: existing, created: false };
      }

      const message = await this.read(ref);
      if (!message) throw new Error('Message not readable after creation');
      return { message, created: true };
    });
  }

  async findById(chatId: string, messageId: string): Promise<Message | null> {
    return withFirestore(() => this.read(this.collection(chatId).doc(messageId)));
  }

  async listBefore(chatId: string, limit: number, before?: MessagePosition): Promise<MessagePage> {
    return withFirestore(async () => {
      // Newest first; document ID breaks ties so ordering is total and stable.
      let query = this.collection(chatId)
        .orderBy('createdAt', 'desc')
        .orderBy(FieldPath.documentId(), 'desc')
        .limit(limit + 1);
      if (before) {
        query = query.startAfter(new Timestamp(before.seconds, before.nanos), before.id);
      }
      const snapshot = await query.get();
      const messages = snapshot.docs.map((doc) => toMessage(doc));
      return { messages: messages.slice(0, limit), hasMore: messages.length > limit };
    });
  }

  edit(
    chatId: string,
    messageId: string,
    editorId: string,
    text: string,
  ): Promise<MessageMutation> {
    return this.mutate(chatId, messageId, editorId, (current) =>
      current.deletedAt
        ? null
        : { text, editedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
    );
  }

  softDelete(chatId: string, messageId: string, actorId: string): Promise<MessageMutation> {
    return this.mutate(chatId, messageId, actorId, (current) =>
      current.deletedAt
        ? null
        : {
            text: '',
            deletedAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
    );
  }

  /**
   * Read-check-write in a transaction so concurrent edits/deletes cannot interleave
   * (e.g. an edit landing after a delete would resurrect the text).
   * `change` returns null when the message is already deleted.
   */
  private async mutate(
    chatId: string,
    messageId: string,
    actorId: string,
    change: (current: Message) => Record<string, unknown> | null,
  ): Promise<MessageMutation> {
    return withFirestore(async () => {
      const ref = this.collection(chatId).doc(messageId);
      const outcome = await this.db.runTransaction(
        async (tx): Promise<'OK' | 'ALREADY_DELETED' | 'NOT_FOUND' | 'NOT_SENDER'> => {
          const snapshot = await tx.get(ref);
          if (!snapshot.exists) return 'NOT_FOUND';
          const current = toMessage(snapshot);
          if (current.senderId !== actorId) return 'NOT_SENDER';
          const update = change(current);
          if (!update) return 'ALREADY_DELETED';
          tx.update(ref, update);
          return 'OK';
        },
      );
      if (outcome === 'NOT_FOUND' || outcome === 'NOT_SENDER') return { status: outcome };
      const message = await this.read(ref);
      if (!message) return { status: 'NOT_FOUND' };
      return { status: outcome, message };
    });
  }

  private collection(chatId: string): CollectionReference {
    return this.db.collection('chats').doc(chatId).collection('messages');
  }

  private async read(ref: DocumentReference): Promise<Message | null> {
    const snapshot = await ref.get();
    return snapshot.exists ? toMessage(snapshot) : null;
  }
}

function toMessage(snapshot: DocumentSnapshot): Message {
  const doc = messageDocSchema.parse(snapshot.data());
  return {
    id: snapshot.id,
    chatId: doc.chatId,
    senderId: doc.senderId,
    text: doc.text,
    createdAt: doc.createdAt.toDate(),
    updatedAt: doc.updatedAt.toDate(),
    editedAt: doc.editedAt?.toDate() ?? null,
    deletedAt: doc.deletedAt?.toDate() ?? null,
    position: {
      seconds: doc.createdAt.seconds,
      nanos: doc.createdAt.nanoseconds,
      id: snapshot.id,
    },
  };
}

function hashIdempotencyKey(senderId: string, key: string): string {
  return createHash('sha256').update(`${senderId}\n${key}`).digest('base64url');
}

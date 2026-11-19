import { z } from 'zod';
import {
  loginBodySchema,
  refreshBodySchema,
  registerBodySchema,
} from '../modules/auth/auth.schema.js';
import { createChatBodySchema } from '../modules/chats/chat.schema.js';
import {
  lastSeenBodySchema,
  markReadBodySchema,
  sendMessageBodySchema,
} from '../modules/messages/message.schema.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../shared/validation/common.schema.js';

type JsonSchema = Record<string, unknown>;

/** OpenAPI 3.1 uses JSON Schema 2020-12, which Zod 4 emits natively. */
function schemaOf(schema: z.ZodType, io: 'input' | 'output' = 'input'): JsonSchema {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  return rest;
}

const isoDate = z.iso.datetime();

const userDoc = z.object({ id: z.uuid(), name: z.string(), email: z.email(), createdAt: isoDate });
const tokensDoc = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().describe('Access-token lifetime in seconds'),
});
const chatDoc = z.object({
  chatId: z.uuid(),
  type: z.enum(['DIRECT', 'GROUP']),
  memberIds: z.array(z.uuid()),
  members: z.array(z.object({ userId: z.uuid(), name: z.string(), joinedAt: isoDate })),
  lastMessageId: z.string().nullable(),
  lastMessageAt: isoDate.nullable(),
  lastActivityAt: isoDate,
  createdAt: isoDate,
  updatedAt: isoDate,
});
const messageDoc = z.object({
  id: z.string(),
  chatId: z.uuid(),
  senderId: z.uuid(),
  text: z.string(),
  createdAt: isoDate.describe('Server-generated Firestore timestamp'),
  updatedAt: isoDate,
  editedAt: isoDate.nullable(),
});
const receiptDoc = z.object({
  chatId: z.uuid(),
  messageId: z.string(),
  userId: z.uuid(),
  readAt: isoDate,
  created: z.boolean().describe('false when the receipt already existed (idempotent replay)'),
});
const lastSeenDoc = z.object({
  chatId: z.uuid(),
  userId: z.uuid(),
  messageId: z.string(),
  messageCreatedAt: isoDate,
  lastSeenAt: isoDate,
  updated: z.boolean().describe('false when the request would have moved the pointer backwards'),
});
const pageMeta = z.object({
  limit: z.number().int(),
  nextCursor: z.string().nullable().describe('Pass as ?cursor= to fetch the next page'),
});

const errorBody = {
  type: 'object',
  required: ['success', 'error'],
  properties: {
    success: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message', 'details'],
      properties: {
        code: { type: 'string', example: 'VALIDATION_ERROR' },
        message: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              message: { type: 'string' },
              location: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

function success(data: JsonSchema, meta?: JsonSchema): JsonSchema {
  return {
    type: 'object',
    required: ['success', 'data'],
    properties: { success: { const: true }, data, ...(meta ? { meta } : {}) },
  };
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Validation error or malformed request',
  401: 'Missing, invalid or expired credentials',
  403: 'Authenticated but not allowed (e.g. not a chat member, impersonation)',
  404: 'Resource not found',
  409: 'Conflict',
  413: 'Request body too large',
  422: 'Semantically invalid request',
  429: 'Rate limit exceeded',
  503: 'A dependency (PostgreSQL or Firestore) is unavailable; safe to retry',
};

interface Operation {
  tag: string;
  summary: string;
  description?: string;
  secured?: boolean;
  parameters?: JsonSchema[];
  body?: z.ZodType;
  responses: Record<number, { description: string; schema?: JsonSchema; headers?: JsonSchema }>;
  errors: number[];
}

function operation(op: Operation): JsonSchema {
  const responses: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(op.responses)) {
    responses[status] = {
      description: response.description,
      ...(response.headers ? { headers: response.headers } : {}),
      ...(response.schema ? { content: { 'application/json': { schema: response.schema } } } : {}),
    };
  }
  for (const status of [...op.errors, 500]) {
    responses[String(status)] = { $ref: `#/components/responses/Error${status}` };
  }
  return {
    tags: [op.tag],
    summary: op.summary,
    ...(op.description ? { description: op.description } : {}),
    ...(op.secured === false ? { security: [] } : {}),
    ...(op.parameters ? { parameters: op.parameters } : {}),
    ...(op.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schemaOf(op.body) } },
          },
        }
      : {}),
    responses,
  };
}

const pathParam = (name: string, description: string, format?: string): JsonSchema => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', ...(format ? { format } : {}) },
});

const pageParams: JsonSchema[] = [
  {
    name: 'limit',
    in: 'query',
    schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
  },
  { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque cursor' },
];

const authResult = success(schemaOf(z.object({ user: userDoc, tokens: tokensDoc }), 'output'));
const chatIdParam = pathParam('chatId', 'Chat UUID', 'uuid');

export function buildOpenApiDocument(version: string): JsonSchema {
  const errorResponses = Object.fromEntries(
    [...Object.entries(ERROR_DESCRIPTIONS), ['500', 'Unexpected server error']].map(
      ([status, description]) => [
        `Error${status}`,
        { description, content: { 'application/json': { schema: errorBody } } },
      ],
    ),
  );

  return {
    openapi: '3.1.0',
    info: {
      title: 'Chat Backend API',
      version,
      description:
        'One-to-one chat backend. PostgreSQL stores users, chats and memberships; Firestore stores ' +
        'messages, read receipts and last-seen pointers.\n\n' +
        'All routes are served under `/api/v1` and, for compatibility with the original ' +
        'assignment contract, also at the unversioned path. Identity is always taken from the ' +
        'Bearer access token: `senderId` / `userId` body fields are optional and, if present, ' +
        'must equal the authenticated user.',
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'Auth' },
      { name: 'Users' },
      { name: 'Chats' },
      { name: 'Messages' },
      { name: 'Health' },
    ],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      responses: errorResponses,
    },
    paths: {
      '/auth/register': {
        post: operation({
          tag: 'Auth',
          summary: 'Register a user',
          secured: false,
          body: registerBodySchema,
          responses: { 201: { description: 'Registered and signed in', schema: authResult } },
          errors: [400, 409, 429],
        }),
      },
      '/auth/login': {
        post: operation({
          tag: 'Auth',
          summary: 'Log in with email and password',
          secured: false,
          body: loginBodySchema,
          responses: { 200: { description: 'Signed in', schema: authResult } },
          errors: [400, 401, 429],
        }),
      },
      '/auth/refresh': {
        post: operation({
          tag: 'Auth',
          summary: 'Rotate a refresh token',
          description:
            'Each refresh token is single-use. Re-using a consumed token revokes every token ' +
            'issued from the same login (theft detection).',
          secured: false,
          body: refreshBodySchema,
          responses: {
            200: {
              description: 'New token pair',
              schema: success(schemaOf(z.object({ tokens: tokensDoc }), 'output')),
            },
          },
          errors: [400, 401, 429],
        }),
      },
      '/auth/logout': {
        post: operation({
          tag: 'Auth',
          summary: 'Revoke a refresh-token family',
          secured: false,
          body: refreshBodySchema,
          responses: { 204: { description: 'Logged out' } },
          errors: [400],
        }),
      },
      '/users/me': {
        get: operation({
          tag: 'Users',
          summary: 'Current user profile',
          responses: {
            200: { description: 'Profile', schema: success(schemaOf(userDoc, 'output')) },
          },
          errors: [401, 404],
        }),
      },
      '/user/{userId}/chats': {
        get: operation({
          tag: 'Users',
          summary: "List the authenticated user's chats (most recent activity first)",
          description: '`userId` must be the authenticated user. Alias: `/users/{userId}/chats`.',
          parameters: [pathParam('userId', 'User UUID', 'uuid'), ...pageParams],
          responses: {
            200: {
              description: 'Page of chats',
              schema: success(schemaOf(z.array(chatDoc), 'output'), schemaOf(pageMeta, 'output')),
            },
          },
          errors: [400, 401, 403],
        }),
      },
      '/chat/create': {
        post: operation({
          tag: 'Chats',
          summary: 'Create or get the one-to-one chat between two users',
          description:
            'The authenticated user must be `userAId` or `userBId`. Concurrent calls for the same ' +
            'pair always resolve to a single chat (enforced by a UNIQUE constraint).',
          body: createChatBodySchema,
          responses: {
            201: {
              description: 'Chat created',
              schema: success(
                schemaOf(
                  z.object({ chatId: z.uuid(), created: z.literal(true), chat: chatDoc }),
                  'output',
                ),
              ),
            },
            200: {
              description: 'Existing chat returned',
              schema: success(
                schemaOf(
                  z.object({ chatId: z.uuid(), created: z.literal(false), chat: chatDoc }),
                  'output',
                ),
              ),
            },
          },
          errors: [400, 401, 403, 404, 422],
        }),
      },
      '/chat/{chatId}/message/send': {
        post: operation({
          tag: 'Messages',
          summary: 'Send a message',
          description:
            'Supply an `Idempotency-Key` header to make retries safe: repeating the same key ' +
            'returns the original message with status 200 and `Idempotent-Replayed: true`.',
          parameters: [
            chatIdParam,
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{8,128}$' },
            },
          ],
          body: sendMessageBodySchema,
          responses: {
            201: {
              description: 'Message stored',
              schema: success(schemaOf(messageDoc, 'output')),
            },
            200: {
              description: 'Idempotent replay of a previously stored message',
              schema: success(schemaOf(messageDoc, 'output')),
            },
          },
          errors: [400, 401, 403, 404, 409, 413, 503],
        }),
      },
      '/chat/{chatId}/messages': {
        get: operation({
          tag: 'Messages',
          summary: 'Get messages',
          description:
            'Returns the newest page first; messages inside a page are in chronological order. ' +
            'Follow `meta.nextCursor` to load older messages.',
          parameters: [chatIdParam, ...pageParams],
          responses: {
            200: {
              description: 'Page of messages',
              schema: success(
                schemaOf(z.array(messageDoc), 'output'),
                schemaOf(pageMeta, 'output'),
              ),
            },
          },
          errors: [400, 401, 403, 404, 503],
        }),
      },
      '/chat/{chatId}/message/{messageId}/read': {
        post: operation({
          tag: 'Messages',
          summary: 'Mark a message as read (idempotent)',
          parameters: [chatIdParam, pathParam('messageId', 'Firestore message ID')],
          body: markReadBodySchema,
          responses: {
            201: {
              description: 'Receipt created',
              schema: success(schemaOf(receiptDoc, 'output')),
            },
            200: {
              description: 'Receipt already existed; original readAt returned',
              schema: success(schemaOf(receiptDoc, 'output')),
            },
          },
          errors: [400, 401, 403, 404, 503],
        }),
      },
      '/chat/{chatId}/lastseen': {
        post: operation({
          tag: 'Messages',
          summary: 'Advance the last-seen message pointer',
          description: 'The pointer only moves forward; older messages leave it unchanged.',
          parameters: [chatIdParam],
          body: lastSeenBodySchema,
          responses: {
            200: {
              description: 'Current pointer',
              schema: success(schemaOf(lastSeenDoc, 'output')),
            },
          },
          errors: [400, 401, 403, 404, 503],
        }),
      },
    },
  };
}

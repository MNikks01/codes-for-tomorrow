export interface UserRecord {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewUser {
  name: string;
  email: string;
  passwordHash: string;
}

export interface UserRepository {
  create(data: NewUser): Promise<UserRecord>;
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  countExisting(ids: readonly string[]): Promise<number>;
}

/** The only user shape that ever leaves the service layer (no password hash). */
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
}

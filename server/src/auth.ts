/**
 * Email/password authentication and bearer sessions.
 *
 * Passwords are stored as scrypt hashes with a per-user salt and compared in
 * constant time. Session tokens are random 256-bit values; only their SHA-256
 * is persisted, so a stolen database does not yield usable tokens.
 */

import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { assertValid, SCHEMA_VERSION, userSchema, type User } from '../../shared/src/index.js';
import { SqliteStore } from './store/sqlite.js';
import { TABLES, asRow, toRecord, type SessionRow, type UserRow } from './store/tables.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 16384;

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, { N: SCRYPT_COST }).toString('hex');
}

function passwordMatches(password: string, row: UserRow): boolean {
  const candidate = Buffer.from(hashPassword(password, row.salt), 'hex');
  const expected = Buffer.from(row.passwordHash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function publicUser(row: UserRow): User {
  return assertValid<User>(
    {
      schemaVersion: SCHEMA_VERSION,
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      createdAt: row.createdAt,
    },
    userSchema,
    'user',
  );
}

export interface Session {
  user: UserRow;
  token: string;
  expiresAt: number;
}

export class AuthService {
  constructor(
    private readonly store: SqliteStore,
    private readonly now: () => number,
  ) {}

  signup(email: string, password: string, displayName?: string): Session {
    const normalized = normalizeEmail(email);
    if (this.findByEmail(normalized)) {
      throw new AuthError(409, 'email_taken', 'an account with that email already exists');
    }
    const salt = randomBytes(16).toString('hex');
    const row: UserRow = {
      id: `usr_${randomUUID().replace(/-/g, '')}`,
      email: normalized,
      displayName: displayName?.trim() || normalized.split('@')[0]!,
      createdAt: this.now(),
      passwordHash: hashPassword(password, salt),
      salt,
    };
    this.store.transaction((tx) => tx.put(TABLES.users, toRecord(row)));
    return this.issue(row);
  }

  login(email: string, password: string): Session {
    const row = this.findByEmail(normalizeEmail(email));
    // Same error for unknown account and wrong password: the API must not
    // reveal which addresses have accounts.
    if (!row || !passwordMatches(password, row)) {
      throw new AuthError(401, 'invalid_credentials', 'email or password is incorrect');
    }
    return this.issue(row);
  }

  private issue(user: UserRow): Session {
    const token = randomBytes(32).toString('base64url');
    const session: SessionRow = {
      id: tokenDigest(token),
      userId: user.id,
      createdAt: this.now(),
      expiresAt: this.now() + SESSION_TTL_MS,
    };
    this.store.transaction((tx) => tx.put(TABLES.sessions, toRecord(session)));
    return { user, token, expiresAt: session.expiresAt };
  }

  /** Resolves a bearer token, or throws 401. Expired sessions are removed. */
  authenticate(token: string | undefined): UserRow {
    if (!token) throw new AuthError(401, 'unauthenticated', 'a bearer token is required');
    const session = asRow<SessionRow>(this.store.get(TABLES.sessions, tokenDigest(token)));
    if (!session) throw new AuthError(401, 'unauthenticated', 'unknown or revoked token');
    if (session.expiresAt <= this.now()) {
      this.store.transaction((tx) => tx.delete(TABLES.sessions, session.id));
      throw new AuthError(401, 'session_expired', 'session has expired');
    }
    const user = asRow<UserRow>(this.store.get(TABLES.users, session.userId));
    if (!user) throw new AuthError(401, 'unauthenticated', 'account no longer exists');
    return user;
  }

  logout(token: string | undefined): void {
    if (!token) return;
    this.store.transaction((tx) => tx.delete(TABLES.sessions, tokenDigest(token)));
  }

  findByEmail(email: string): UserRow | undefined {
    return asRow<UserRow>(this.store.firstBy(TABLES.users, 'email', normalizeEmail(email)));
  }
}

import { createHash, randomBytes } from "node:crypto";
import { getCollections } from "./db.js";

const KEY_PREFIX = "imp";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function generateApiKey(): { prefix: string; secret: string; full: string } {
  const prefix = randomBytes(3).toString("hex").toLowerCase();
  const secret = randomBytes(18).toString("base64url");
  return { prefix, secret, full: `${KEY_PREFIX}_${prefix}_${secret}` };
}

export async function createApiKey(opts: {
  userId: string;
  name: string;
}): Promise<{ full: string; keyId: string; name: string; createdAt: Date }> {
  const { api_keys } = await getCollections();
  const { prefix, full } = generateApiKey();
  const keyHash = hashSecret(full);
  const now = new Date();
  await api_keys.insertOne({
    userId: opts.userId,
    name: opts.name,
    keyHash,
    prefix,
    createdAt: now,
  });
  return { full, keyId: prefix, name: opts.name, createdAt: now };
}

export async function listApiKeys(userId: string) {
  const { api_keys } = await getCollections();
  const docs = await api_keys.find({ userId }).sort({ createdAt: -1 }).toArray();
  return docs.map(({ _id: _docId, keyHash: _hash, ...rest }) => ({
    ...rest,
    keyId: String(_docId),
  }));
}

export async function revokeApiKey(userId: string, prefix: string) {
  const { api_keys } = await getCollections();
  const { deletedCount } = await api_keys.deleteOne({ userId, prefix });
  return deletedCount > 0;
}

export type ResolvedApiKey = {
  userId: string;
  keyId: string;
  name: string;
};

/** Resolve a stored key from its hash. Returns the owning userId, prefix/keyId, and name. */
export async function resolveApiKey(fullKey: string): Promise<ResolvedApiKey | undefined> {
  const keyHash = hashSecret(fullKey);
  const { api_keys } = await getCollections();
  const doc = await api_keys.findOne({ keyHash });
  if (!doc) return undefined;
  await api_keys.updateOne(
    { _id: doc._id },
    { $set: { lastUsedAt: new Date() } }
  );
  return {
    userId: doc.userId,
    keyId: doc.prefix,
    name: doc.name,
  };
}
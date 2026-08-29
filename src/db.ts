import { MongoClient } from "mongodb";

const globalForMongo = globalThis as unknown as { _mongoClient?: MongoClient };

async function getClient(): Promise<MongoClient> {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("Missing MONGO_URI in environment");
  if (!globalForMongo._mongoClient) {
    globalForMongo._mongoClient = new MongoClient(uri);
    const client = globalForMongo._mongoClient;
    client.on("close", () => {
      globalForMongo._mongoClient = undefined;
      collections = null;
    });
    client.on("error", () => {
      globalForMongo._mongoClient = undefined;
      collections = null;
    });
    await client.connect();
  }
  return globalForMongo._mongoClient;
}

export async function getDb() {
  const client = await getClient();
  const dbName = process.env.MONGO_DB || "seo_console";
  return client.db(dbName);
}

/** Close the shared client so CLI scripts can exit cleanly. */
export async function closeDb() {
  const client = globalForMongo._mongoClient;
  if (client) {
    await client.close();
    globalForMongo._mongoClient = undefined;
    collections = null;
  }
}

export type PageDoc = {
  userId: string;
  siteUrl: string;
  path: string;
  url: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  syncedAt: Date;
  createdAt?: Date;
  active?: boolean;
};

export type PageContentDoc = {
  userId: string;
  siteUrl: string;
  path: string;
  httpStatus: number;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  headings: { level: number; text: string }[];
  wordCount: number;
  textSample: string;
  structuredData: unknown[];
  etag?: string | null;
  lastModified?: string | null;
  fetchedAt: Date;
};

export type RecEnhancementDoc = {
  userId: string;
  siteUrl: string;
  recId: string;
  fingerprint: string;
  why: string;
  steps: string[];
  draftTitle?: string | null;
  draftMeta?: string | null;
  agentPrompt?: string;
  updatedAt: Date;
};

export type IdeaDoc = {
  id: string;
  type: "gap" | "striking-distance" | "intent-mismatch" | "winner-expansion" | "new-topic";
  topic: string;
  tokens: string[];
  queriesCount: number;
  impressions90d: number;
  clicks90d: number;
  ctr: number;
  weightedPosition: number;
  projectedClicksPerMonth: { low: number; high: number };
  confidence: "low" | "medium" | "high";
  branded: boolean;
  evidenceNote: string;
  angle?: string;
  outline?: string[];
  evidence: {
    topQueries: { query: string; impressions: number; clicks: number; position: number }[];
    coveringPages: string[];
    autocompletePhrasings: string[];
    validated: boolean;
  };
};

export type IdeaRunDoc = {
  userId: string;
  siteUrl: string;
  generatedAt: Date;
  stats: {
    windowDays: number;
    queriesAnalyzed: number;
    brandedFiltered: number;
    clustersFormed: number;
    ideasReturned: number;
    aiPackaged: boolean;
    discoveryPhrasings?: number;
    discoveryTopics?: number;
    partialData?: boolean;
    degraded?: boolean;
    carriedFromPreviousRun?: number;
  };
  ideas: IdeaDoc[];
};

export type UserDoc = {
  userId: string;
  email: string;
  onboarded: boolean;
  siteUrl: string;
  product: {
    type?: string;
    audience?: string;
    goal?: string;
  };
  properties: { url: string; permissionLevel: string; addedAt: Date }[];
  activeProperty: string;
  googleRefreshToken?: string;
  widgetToken?: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ApiKeyDoc = {
  userId: string;
  name: string;
  keyHash: string; // sha256 hex of the secret portion
  prefix: string; // visible id used for lookup/debug
  createdAt: Date;
  lastUsedAt?: Date;
};

type Collections = {
  pages: import("mongodb").Collection<PageDoc>;
  page_content: import("mongodb").Collection<PageContentDoc>;
  rec_enhancements: import("mongodb").Collection<RecEnhancementDoc>;
  users: import("mongodb").Collection<UserDoc>;
  idea_runs: import("mongodb").Collection<IdeaRunDoc>;
  api_keys: import("mongodb").Collection<ApiKeyDoc>;
};

let collections: Collections | null = null;

export async function getCollections(): Promise<Collections> {
  if (collections) return collections;
  const client = await getClient();
  const db = client.db(process.env.MONGO_DB || "seo_console");

  const pages = db.collection<PageDoc>("pages");
  const page_content = db.collection<PageContentDoc>("page_content");
  const rec_enhancements = db.collection<RecEnhancementDoc>("rec_enhancements");
  const users = db.collection<UserDoc>("users");
  const idea_runs = db.collection<IdeaRunDoc>("idea_runs");
  const api_keys = db.collection<ApiKeyDoc>("api_keys");

  collections = { pages, page_content, rec_enhancements, users, idea_runs, api_keys };
  return collections;
}
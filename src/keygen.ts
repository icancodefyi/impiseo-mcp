import "dotenv/config";
import { closeDb, getCollections } from "./db.js";
import { createApiKey } from "./keys.js";

// pnpm tsx src/keygen.ts <userId|email> [name]
async function main() {
  const [arg] = process.argv.slice(2);
  if (!arg) {
    console.error("Usage: pnpm tsx src/keygen.ts <userId|email> [name]");
    process.exit(1);
  }
  const name = process.argv[3] ?? "mcp";

  const { users } = await getCollections();
  const user = await users.findOne({
    $or: [{ userId: arg }, { email: arg.toLowerCase() }],
  });
  if (!user) {
    console.error(`No user found for "${arg}". Check MONGO_URI/MONGO_DB.`);
    process.exit(1);
  }
  const created = await createApiKey({ userId: user.userId, name });
  console.log("\nCreated API key:");
  console.log("  key: ", created.full);
  console.log("  user:", user.userId);
  console.log("  name:", created.name);
  console.log("\nConnect your AI to the MCP server with this key (Authorization: Bearer).");
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
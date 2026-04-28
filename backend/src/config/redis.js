const { createClient } = require("redis");

const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redisClient.on("connect", () => {
  console.log("✅ Redis connected successfully");
});

redisClient.on("error", (err) => {
  console.error("⚠️  Redis error (non-fatal):", err.message);
});

// Connect but don't crash if it fails
redisClient.connect().catch((err) => {
  console.error("⚠️  Redis connection failed (non-fatal):", err.message);
});

module.exports = redisClient;

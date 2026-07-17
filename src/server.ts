import "dotenv/config";
import cors from "cors";
import express from "express";
import apiRoutes from "./routes/index.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { MODEL, hasKey } from "./services/claude.service.js";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()) ?? true,
  }),
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`ScoutIQ API listening on http://localhost:${PORT}`);
  console.log(
    hasKey()
      ? `Claude explanations: live (${MODEL}), cached to ./cache`
      : "Claude explanations: no ANTHROPIC_API_KEY — serving canned fallback reports",
  );
});

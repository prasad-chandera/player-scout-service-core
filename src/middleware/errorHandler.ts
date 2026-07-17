import type { ErrorRequestHandler, RequestHandler } from "express";
import { ApiError } from "../utils/errors.js";

/** Unmatched path — shaped like every other error so clients only parse one thing. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` },
  });
};

/**
 * Express 5 forwards both synchronous throws and rejected promises from handlers here,
 * which is why controllers can `throw playerNotFound(id)` with no try/catch.
 *
 * The four-argument signature is what marks this as an error handler — Express detects
 * it by arity, so `_next` must stay even though it is unused.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong on the server." },
  });
};

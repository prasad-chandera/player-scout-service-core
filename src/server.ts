import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import rateLimit from 'express-rate-limit'
import path from 'path'
import fs from 'fs'

import indexRouter from './routes/index'
import internalRouter from './routes/internal'
import config from './configs/config'

// CORS — only allow requests from known frontend origins
const allowedOrigins = [config.urlsConfig.WEBSITE_URL].filter(
	Boolean
) as string[]

// Rate limiting configuration
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutes
	max: 500, // Limit each IP to 500 requests per window
	standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
	legacyHeaders: false, // Disable `X-RateLimit-*` headers
	message: {
		status: 429,
		message: 'Too many requests, please try again later.'
	},
	skip: (req) => {
		// Skip rate limiting for health checks
		return req.path === '/health' || req.path === '/api/health'
	}
})

const app = express()

// Trust proxy - required when behind a reverse proxy (nginx, load balancer, etc.)
// This ensures express-rate-limit gets the correct client IP from X-Forwarded-For
// Set to 1 to trust the first proxy, or true to trust all proxies
app.set('trust proxy', 1)

// =============================================================================
// MIDDLEWARE ORDER EXPLANATION:
// 1. Security headers (helmet, cors) - Applied first for security
// 2. Body parsing - Parse request body before rate limiting for context access
// 3. Rate limiting - After parsing to access body (e.g., for user identification)
// 4. Response compression - After rate limiting to avoid compressing rejected requests
// 5. Cache control - Set response headers
// 8. Routes - Application routes
// 9. Error handler - Must be last
// =============================================================================

// Security headers - must be very early
app.use(helmet())
app.use(
	cors({
		origin: (origin, callback) => {
			// Allow requests with no origin (server-to-server, webhooks, mobile apps)
			if (
				!origin ||
				allowedOrigins.includes(origin) ||
				config.appConfig.NODE_ENV !== 'production'
			) {
				callback(null, true)
			} else {
				callback(new Error('Not allowed by CORS'))
			}
		},
		credentials: true
	})
)

// Body parsing - before rate limiting to give limiters access to request body
// The verify callback captures the raw body string for webhook signature verification
app.use(
	express.json({
		limit: '1mb',
		verify: (req, _res, buf) => {
			;(req as typeof req & { rawBody?: string }).rawBody = buf.toString()
		}
	})
)
app.use(express.urlencoded({ extended: false }))

// Apply general rate limiting to all API routes
// Now has access to parsed body for enhanced rate limiting strategies
app.use('/api/', apiLimiter)

// Response compression - placed after rate limiting to avoid compressing
// responses for rate-limited requests, saving CPU cycles
app.use(compression())

// Cache control headers
app.use('/', (_req, res, next) => {
	// make sure no 304 request is sent
	res.set('Last-Modified', new Date().toUTCString())
	res.set('ETag', 'no-cache')
	res.set(
		'Cache-Control',
		'no-store, no-cache, must-revalidate, proxy-revalidate'
	)
	res.set('Pragma', 'no-cache')
	res.set('Expires', '0')
	next()
})

// Serve OpenAPI specification (public endpoint)
app.get('/openapi', (_req, res) => {
	const openapiPath = path.join(process.cwd(), 'packages/openapi/openapi.yaml')
	if (fs.existsSync(openapiPath)) {
		res.setHeader('Content-Type', 'text/yaml')
		res.sendFile(openapiPath)
	} else {
		res.status(404).json({ error: 'OpenAPI specification not found' })
	}
})

// Internal service-to-service routes (before auth middleware, own auth)
app.use('/api/internal', internalRouter)

// Health check - before auth middleware
app.get('/api/health', (_req, res) => {
	res.status(200).json({
		status: 'success',
		service: 'wocul-core',
		timestamp: new Date().toISOString()
	})
})

app.use('/api', indexRouter)

// Global error handler - must be last middleware
app.use(
	(
		err: Error,
		req: express.Request,
		res: express.Response,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_next: express.NextFunction
	) => {
		// Log error for debugging
		// eslint-disable-next-line no-console
		console.error('[Global Error Handler]', {
			error: err.message,
			stack: err.stack,
			path: req.path,
			method: req.method
		})

		// Determine status code
		const statusCode = (err as { statusCode?: number }).statusCode || 500

		// Send error response
		res.status(statusCode).json({
			error: err.name || 'InternalServerError',
			message: err.message || 'An unexpected error occurred',
			...(process.env.NODE_ENV === 'development' && { stack: err.stack })
		})
	}
)

export default app

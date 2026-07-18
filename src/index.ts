import 'dotenv/config'
import { Server } from 'http'

import app from './server'
import CONFIG from './configs/config'

const PORT = CONFIG.appConfig.APP_PORT

let server: Server | null = null

/**
 * Graceful shutdown handler
 * Properly closes all database connections and HTTP server before process exit
 */
async function gracefulShutdown(signal: string): Promise<void> {
	// eslint-disable-next-line no-console
	console.log(`\n${signal} received. Starting graceful shutdown...`)

	// Stop accepting new connections
	if (server) {
		// Wrap server.close in a Promise to properly await it
		await new Promise<void>((resolve, reject) => {
			server!.close((error) => {
				if (error) {
					// eslint-disable-next-line no-console
					console.error('Error closing HTTP server:', error)
					reject(error)
				} else {
					// eslint-disable-next-line no-console
					console.log('HTTP server closed')
					resolve()
				}
			})
		})

		try {
			// eslint-disable-next-line no-console
			console.log('Graceful shutdown completed')
			process.exit(0)
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('Error during graceful shutdown:', error)
			process.exit(1)
		}
	} else {
		// Server not started yet, just close connections
		try {
			process.exit(0)
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('Error closing connections:', error)
			process.exit(1)
		}
	}
}

// Register shutdown handlers for graceful termination
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'))

// Handle uncaught errors
process.on('uncaughtException', (error: Error) => {
	// eslint-disable-next-line no-console
	console.error('Uncaught Exception:', error)
	// Exit immediately - process is in unstable state
	process.exit(1)
})

process.on(
	'unhandledRejection',
	(reason: unknown, promise: Promise<unknown>) => {
		// eslint-disable-next-line no-console
		console.error('Unhandled Rejection at:', promise, 'reason:', reason)
		// Exit immediately - process is in unstable state
		process.exit(1)
	}
)

app.listen(PORT, () => {
	// eslint-disable-next-line no-console
	console.log(`Server is running on http://localhost:${PORT}`)
})

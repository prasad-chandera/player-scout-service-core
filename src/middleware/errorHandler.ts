import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod/v4'

import { ApiError } from '../utils/errors.js'
import { getResponseCode } from '../utils/responseCodes.js'

export class CustomError extends Error {
	error: string
	statusCode: number
	validationResult?: ZodError | null

	constructor(
		error: string,
		message: string,
		validationResult?: ZodError | null
	) {
		super(message)
		this.error = error
		this.statusCode = getResponseCode(error)
		this.validationResult = validationResult
	}
}

export function notFoundHandler(req: Request, res: Response): void {
	res.status(404).json({
		error: {
			code: 'NOT_FOUND',
			message: `Route ${req.method} ${req.originalUrl} not found`
		}
	})
}

export function errorHandler(
	err: unknown,
	_req: Request,
	res: Response,
	_next: NextFunction
): void {
	if (err instanceof ApiError) {
		res.status(err.status).json({
			error: { code: err.code, message: err.message }
		})
		return
	}

	if (err instanceof CustomError) {
		res.status(err.statusCode).json({
			error: { code: err.error, message: err.message }
		})
		return
	}

	if (err instanceof ZodError) {
		res.status(400).json({
			error: {
				code: 'VALIDATION_ERROR',
				message: err.issues.map((issue) => issue.message).join(', ')
			}
		})
		return
	}

	console.error(err)
	res.status(500).json({
		error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' }
	})
}

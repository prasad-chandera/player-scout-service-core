import { Request, Response } from 'express'
import { ZodError } from 'zod/v4'

import { getResponseCode } from '../utils/responseCodes'

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

	public throwError(_req: Request, res: Response) {
		res.status(this.statusCode).json({
			error: this.error,
			message: this.message,
			validationResult: this.validationResult || null
		})
	}
}

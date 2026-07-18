export function getResponseCode(status: string): number {
	let code = 500
	switch (status) {
		case 'SUCCESS':
			code = 200
			break
		case 'LIMIT_EXCEEDED':
			code = 429
			break
		case 'BAD_REQUEST':
		case 'SIGNUP_REQUIRED':
			code = 400
			break
		case 'AUTHENTICATION_FAILED':
		case 'UNAUTHORIZED':
			code = 401
			break
		case 'FORBIDDEN':
		case 'ACCESS_DENIED':
		case 'ACTION_NOT_ALLOWED':
			code = 403
			break
		case 'ENTITY_NOT_FOUND':
			code = 404
			break
		case 'CONFLICT':
			code = 409
			break
		case 'PRECONDITION_FAILED':
			code = 412
			break
		case 'UNPROCESSABLE_ENTITY':
			code = 422
			break
		case 'PAYMENT_REQUIRED':
			code = 402
			break
		default:
			code = 500
			break
	}
	return code
}

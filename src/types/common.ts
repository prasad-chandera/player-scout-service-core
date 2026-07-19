//Response type
export interface ApiResponse {
	status: 'FAILED' | 'SUCCESS'
	error: string | null
	message: string | null
}

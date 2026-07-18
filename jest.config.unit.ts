import commonConfig from './jest.config'

export default {
	...commonConfig,
	testMatch: ['**/*.unit.test.{js,ts}'],
	testPathIgnorePatterns: ['/node_modules/', '/_archived/'],
	collectCoverageFrom: [
		'**/controllers/*.{js,ts}',
		'**/controllers/*/*.{js,ts}',
		'**/middlewares/*.{js,ts}',
		'**/models/*.{js,ts}',
		'**/models/*/*.{js,ts}',
		'**/services/*.{js,ts}',
		'**/utils/*.{js,ts}',
		'**/crons/*.{js,ts}'
	],
	coverageDirectory: 'coverage/unit',
	setupFilesAfterEnv: ['<rootDir>/tests/unit/setup-transaction-mocks.ts']
}

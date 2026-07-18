import commonConfig from './jest.config'

// Set environment variable to indicate this is an integration test run
process.env.INTEGRATION_TEST = 'true'

export default {
	...commonConfig,
	testMatch: ['**/*.integration.test.{js,ts}'],
	setupFilesAfterEnv: ['<rootDir>/tests/integration/setup.ts'],
	collectCoverageFrom: [
		'src/**/controller/*.{js,ts}',
		'src/**/routes/*.{js,ts}',
		'src/**/middlewares/*.{js,ts}'
	],
	coverageDirectory: 'coverage/integration'
}

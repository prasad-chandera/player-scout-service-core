// Set NODE_ENV early, before any imports
process.env.NODE_ENV = 'test'

export default {
	preset: 'ts-jest',
	testEnvironment: 'node',
	roots: ['<rootDir>/tests'],
	transform: {
		// Transform TS and JS. JS transform is needed for ESM-only deps pulled
		// in by firebase-admin@14 (jose, node-fetch@3) that ship no CJS build.
		'^.+\\.(t|j)sx?$': [
			'ts-jest',
			{ isolatedModules: true, tsconfig: { allowJs: true } }
		]
	},
	moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

	collectCoverage: true,
	coverageDirectory: 'coverage',
	testMatch: [],
	testPathIgnorePatterns: ['/node_modules/', '/tests/setupEnv.js'],
	// Ignore node_modules EXCEPT ESM-only packages that must be transpiled to CJS
	// for Jest (firebase-admin@14's transitive ESM deps).
	transformIgnorePatterns: ['node_modules/(?!(jose|node-fetch)/)'],
	coveragePathIgnorePatterns: ['/node_modules/'],
	openHandlesTimeout: 0,

	// Set NODE_ENV to 'test' to prevent database connections during testing
	setupFiles: ['<rootDir>/tests/setupEnv.js']
}

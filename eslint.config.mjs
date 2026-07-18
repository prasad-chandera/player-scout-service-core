import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'
import jest from 'eslint-plugin-jest'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'

export default [
	{
		ignores: ['dist/', 'packages/mcp-server/dist/']
	},
	{ files: ['src/**/*.{js,ts,jsx,tsx}', 'tests/**/*.{js,ts,jsx,tsx}'] },
	{ files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } },
	{ languageOptions: { globals: globals.node } },
	pluginJs.configs.recommended,
	...tseslint.configs.recommended,
	eslintPluginPrettierRecommended,
	{
		rules: {
			'@typescript-eslint/no-unused-vars': 'error',
			'prettier/prettier': [
				'error',
				{
					trailingComma: 'none',
					singleQuote: true,
					printWidth: 80,
					useTabs: true,
					semi: false,
					bracketSpacing: true,
					jsxSingleQuote: true,
					endOfLine: 'lf'
				}
			],
			'@typescript-eslint/no-empty-object-type': 'off',
			'no-console': 'error'
		}
	},
	{
		files: ['tests/**/*.{js,ts,jsx,tsx}'],
		...jest.configs['flat/recommended'],
		rules: {
			...jest.configs['flat/recommended'].rules,
			'jest/prefer-expect-assertions': 'off',
			'@typescript-eslint/no-explicit-any': 'error',
			'no-console': 'off'
		}
	}
]

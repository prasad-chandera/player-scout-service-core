const appConfig = {
	APP_NAME: process.env.APP_NAME,
	APP_PORT: parseInt(process.env.APP_PORT || '3000', 10),
	NODE_ENV: process.env.NODE_ENV,
	CRONS_ENABLED: process.env.CRONS_ENABLED,
	LOGGING_ENABLED: process.env.LOGGING_ENABLED
}

const awsConfig = {
	AWS_S3_REGION: process.env.AWS_S3_REGION,
	AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
	AWS_SECRET_KEY_ID: process.env.AWS_SECRET_KEY_ID,
	AWS_S3_BUCKET: process.env.AWS_S3_BUCKET,
	AWS_CLOUDWATCH_GROUP_NAME: process.env.AWS_CLOUDWATCH_GROUP_NAME,
	AWS_CLOUDWATCH_REGION: process.env.AWS_CLOUDWATCH_REGION,
	AWS_SES_REGION: process.env.AWS_SES_REGION
}

const urlsConfig = {
	WEBSITE_URL: process.env.WEBSITE_URL,
	WEB_PANEL_COLLAB_URL: process.env.WEB_PANEL_COLLAB_URL,
	WEB_PANEL_STAFF_URL: process.env.WEB_PANEL_STAFF_URL,
	WEB_PANEL_ADMIN_URL: process.env.WEB_PANEL_ADMIN_URL,
	PLAY_STORE_STAFF_URL: process.env.PLAY_STORE_STAFF_URL,
	APP_STORE_STAFF_URL: process.env.APP_STORE_STAFF_URL,
	LOGO_URL: process.env.LOGO_URL
}

const aiConfig = {
	GOOGLE_GENAI_API_KEY: process.env.GOOGLE_GENAI_API_KEY,
	ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
	OPENAI_API_KEY: process.env.OPENAI_API_KEY,
	PINECONE_API_KEY: process.env.PINECONE_API_KEY,
	PINECONE_INDEX: process.env.PINECONE_INDEX,
	ACTIVITY_LOGS_DAYS: parseInt(process.env.ACTIVITY_LOGS_DAYS || '7', 10)
}

const redisConfig = {
	REDIS_HOST: process.env.REDIS_HOST || 'localhost',
	REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379', 10),
	REDIS_PASSWORD: process.env.REDIS_PASSWORD || ''
}

export default {
	appConfig,
	awsConfig,
	urlsConfig,
	aiConfig,
	redisConfig
}

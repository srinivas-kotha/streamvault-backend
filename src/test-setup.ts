// Global test setup — set env vars before any module imports
process.env.JWT_SECRET = 'test-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.POSTGRES_HOST = 'localhost';
process.env.POSTGRES_DB = 'test';
process.env.POSTGRES_USER = 'test';
process.env.POSTGRES_PASSWORD = 'test';
process.env.XTREAM_HOST = 'http://localhost';
process.env.XTREAM_USERNAME = 'test';
process.env.XTREAM_PASSWORD = 'test';

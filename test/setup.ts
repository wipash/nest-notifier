import { mockEnv } from './mockEnv';

// Set up environment variables for SELF.fetch tests
Object.entries(mockEnv).forEach(([key, value]) => {
  process.env[key] = value;
});

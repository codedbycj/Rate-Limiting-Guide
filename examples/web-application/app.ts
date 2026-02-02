/**
 * Web Application Example - Complete implementation with rate limiting
 */

import express from 'express';
import { rateLimit, RateLimitFactory } from '../../implementations/typescript/express-middleware';

const app = express();
app.use(express.json());

const factory = new RateLimitFactory();

// Login - 5 attempts per 15 minutes
app.post('/login', factory.strict(900, 5), (req, res) => {
  res.json({ success: true });
});

// Signup - 3 per hour
app.post('/signup', factory.standard(3600, 3), (req, res) => {
  res.json({ success: true });
});

// API - 60 per minute
app.get('/api/*', factory.standard(60, 60), (req, res) => {
  res.json({ data: 'Sample' });
});

app.listen(3000, () => console.log('Web app running on port 3000'));

export default app;

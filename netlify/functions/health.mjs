import { handleHealthRequest } from '../lib/health.mjs';

export default async (req, context) => handleHealthRequest(req, context);

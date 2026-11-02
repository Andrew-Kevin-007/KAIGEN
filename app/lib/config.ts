// The deployment this build is set up for, read once. NEXT_PUBLIC_DEPLOYMENTS holds the public part of
// deployments.json as JSON text: next.config.ts fills it from the file named by KAIGEN_DEPLOYMENTS, or you set it
// yourself (on Vercel, paste the JSON). It must be written out in full here so the bundler can put the value in.
import { parseDeployments } from "./deployments.ts";

export const DEPLOYMENTS = parseDeployments(process.env.NEXT_PUBLIC_DEPLOYMENTS);

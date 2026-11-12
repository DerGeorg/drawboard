import { Environment } from '../app/services/runtime-config';

/**
 * Image build - the same bundle runs on dev and prod. Everything that differs between them
 * comes from /config.json at runtime (RuntimeConfig), never from here.
 */
export const environment: Environment = {
  production: true,
};

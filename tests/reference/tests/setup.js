// Test fixtures must not depend on the developer's live balance settings.
import { fileURLToPath } from 'node:url';
process.env.LIFEWAR_CONFIG_PATH = fileURLToPath(new URL('./fixtures/config.json', import.meta.url));

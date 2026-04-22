// Astro 5 requires an explicit content collections config. Starlight ships
// a loader + schema we just wire through — no custom fields needed yet.
// See https://starlight.astro.build/getting-started/#astro-5-content-config

import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};

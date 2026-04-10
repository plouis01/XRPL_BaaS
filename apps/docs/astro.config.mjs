import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [
    starlight({
      title: 'RailForge Docs',
      description: 'API reference and guides for the RailForge XRPL BaaS platform.',
      social: {
        github: 'https://github.com/dusa-labs/railforge',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Quickstart', slug: 'getting-started/quickstart' },
            { label: 'Authentication', slug: 'getting-started/authentication' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: 'Accounts', slug: 'api/accounts' },
            { label: 'Tokens', slug: 'api/tokens' },
            { label: 'Payments', slug: 'api/payments' },
            { label: 'Webhooks', slug: 'api/webhooks' },
          ],
        },
        {
          label: 'SDK',
          items: [{ label: 'TypeScript SDK', slug: 'sdk/typescript' }],
        },
      ],
    }),
  ],
});

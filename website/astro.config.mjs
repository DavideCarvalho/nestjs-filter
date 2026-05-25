import starlight from '@astrojs/starlight';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://davidecarvalho.github.io',
  base: '/nestjs-filter',
  integrations: [
    starlight({
      title: 'nestjs-filter',
      description:
        'Declarative, ORM-agnostic filter classes for NestJS — inspired by eloquent-filter and adonis-lucid-filter.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/DavideCarvalho/nestjs-filter',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/DavideCarvalho/nestjs-filter/edit/main/website/',
      },
      customCss: ['./src/styles/global.css'],
      components: {
        Hero: './src/components/Hero.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        PageTitle: './src/components/PageTitle.astro',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: 'Guides',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: 'Packages',
          items: [{ autogenerate: { directory: 'packages' } }],
        },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
  },
});

import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://davidecarvalho.github.io/nestjs-filter'),
  title: {
    default: 'nestjs-filter',
    template: '%s — nestjs-filter',
  },
  description:
    'Declarative, ORM-agnostic filter classes for NestJS — one decorator in the controller, 22 operators, auto-fields, and a typed client-side query builder. MikroORM and TypeORM adapters.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}

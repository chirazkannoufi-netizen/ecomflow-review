/**
 * Configuration Next.js.
 *
 * `transpilePackages` est indispensable : `@ecomflow/shared` est resolu vers
 * ses SOURCES TypeScript (voir `tsconfig.paths`), ce qui evite d'avoir a
 * reconstruire le paquet a chaque modification pendant le developpement.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `standalone` produit un serveur autonome avec ses seules dependances
  // reelles : l'image de production ne contient pas les 400 Mo de
  // `node_modules` du monorepo. Sans effet en developpement.
  output: 'standalone',
  transpilePackages: ['@ecomflow/shared'],
  experimental: {
    // Le paquet partage vit hors du dossier de l'application.
    externalDir: true,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;

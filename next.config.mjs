/**
 * Site 100 % statique (export dans out/), compatible GitHub Pages.
 * NEXT_PUBLIC_BASE_PATH = "/nom-du-depot" pour une page de projet
 * (renseigné automatiquement par .github/workflows/deploy.yml).
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: false, // évite le double montage de la carte WebGL en dev
  transpilePackages: ['three'],
};
export default nextConfig;

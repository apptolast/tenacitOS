/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: produce un servidor minimal en .next/standalone para Docker
  // Permite copiar solo lo necesario al final stage del Dockerfile (sin node_modules completo)
  output: 'standalone',
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS
    ? process.env.ALLOWED_DEV_ORIGINS.split(",")
    : [],
  // External packages que no deben ser bundleados (ej. native modules)
  serverExternalPackages: ['better-sqlite3'],
};

export default nextConfig;

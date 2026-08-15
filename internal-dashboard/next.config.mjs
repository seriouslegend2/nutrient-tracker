/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Backend env vars are SERVER-ONLY. A NEXT_PUBLIC_ prefix would ship the
  // value in the client bundle, which is the whole game.
  env: {},
}
export default nextConfig

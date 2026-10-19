/** @type {import('next').NextConfig} */
const nextConfig = {
  // These talk to raw sockets / read zip archives at runtime; keep them unbundled
  // so Next does not try to statically analyse their dynamic requires.
  serverExternalPackages: ['basic-ftp', 'adm-zip'],
};

export default nextConfig;

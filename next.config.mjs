/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    instrumentationHook: true,
    serverComponentsExternalPackages: ["twilio", "nodemailer", "@prisma/client", "bcryptjs"],
  },
};

export default nextConfig;
